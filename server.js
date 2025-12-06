require('dotenv').config();
const express = require('express');
const sql = require('mssql');
const path = require('path');
const fs = require('fs').promises;

const app = express();
const port = process.env.PORT || 3000;

const dbConfig = {
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    server: process.env.DB_SERVER,
    database: process.env.DB_DATABASE,
    options: {
        encrypt: process.env.DB_ENCRYPT === 'true',
        trustServerCertificate: process.env.DB_TRUST_SERVER_CERTIFICATE === 'true'
    },
    port: 1433,
};

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Middleware to lowercase string values in req.body for POST and PUT requests
app.use((req, res, next) => {
    if ((req.method === 'POST' || req.method === 'PUT') && req.body) {
        const exceptions = [
            'password', 
            'adminpass', 
            'format',       // Book format (Paperback, Hardcover, eBook) - case-sensitive DB check
            'paymentmethod',// Order payment method (Cash, Card, etc.) - case-sensitive DB check & API validation
            'status',       // Order status (Pending, Completed, etc.) - conventionally specific casing
            'email',        // Emails - safer to handle case explicitly for login/uniqueness if needed
            'isbn'          // ISBNs - have specific formatting, safer not to alter case globally
        ];
        for (const key in req.body) {
            if (Object.prototype.hasOwnProperty.call(req.body, key) && typeof req.body[key] === 'string') {
                if (!exceptions.includes(key.toLowerCase())) { // Compare lowercase key for robustness
                    req.body[key] = req.body[key].toLowerCase();
                }
            }
        }
    }
    next();
});

app.use(express.static(path.join(__dirname, 'public')));

let pool;
async function connectDb() {
    try {
        console.log('Attempting to connect to database...');
        pool = await new sql.ConnectionPool(dbConfig).connect();
        console.log(`Connected to database "${process.env.DB_DATABASE}" successfully!`);
        pool.on('error', err => {
            console.error('Database pool error:', err);
        });
    } catch (err) {
        console.error('Database connection failed:', err);
        process.exit(1);
    }
}

// Helper function to convert string to Title Case
function toTitleCase(str) {
    if (!str || typeof str !== 'string') return str;
    return str.toLowerCase().split(' ').map(word => {
        return word.charAt(0).toUpperCase() + word.slice(1);
    }).join(' ');
}

// List of keys (lowercase) to exclude from title casing in GET responses
const titleCaseExceptions = [
    'password', 'adminpass', 'email', 'isbn', 'bookcover',
    'format', 'paymentmethod', 'status', 'language', 'code',
    // date/timestamp fields are generally not title-cased
    'timestamp', 'date', 'createddate', 'orderdate', 'publicationdate', 
    'paymentdate', 'lastlogindate', 'updateddate',
    // Explicitly add common key patterns for URLs or paths
    'url', 'uri', 'path', 'href' 
    // Fields ending with 'ID' (case-insensitive) are handled by a regex in transformDataForTitleCasing
];

// Recursive function to transform object/array data for title casing
function transformDataForTitleCasing(data) {
    if (Array.isArray(data)) {
        return data.map(item => transformDataForTitleCasing(item));
    } else if (typeof data === 'object' && data !== null) {
        const newData = {};
        for (const key in data) {
            if (Object.prototype.hasOwnProperty.call(data, key)) {
                const lowerKey = key.toLowerCase();
                // Check if the key is an exception or matches common ID/URL patterns
                const isExceptionKey = titleCaseExceptions.includes(lowerKey) || 
                                    lowerKey.endsWith('id') || 
                                    lowerKey.endsWith('url') ||
                                    lowerKey.endsWith('uri') ||
                                    lowerKey.endsWith('path');

                if (typeof data[key] === 'string') {
                    // Regex to identify common date string formats from SQL Server:
                    // - YYYY-MM-DD (date only)
                    // - YYYY-MM-DDTHH:mm:ss (datetime)
                    // - YYYY-MM-DDTHH:mm:ss.sss (datetime with milliseconds)
                    // - YYYY-MM-DDTHH:mm:ss.sssZ (datetime with timezone)
                    // - YYYY-MM-DD HH:mm:ss (datetime with space)
                    const dateRegex = /^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}:\d{2}(\.\d{3})?Z?|\s\d{2}:\d{2}:\d{2}(\.\d{3})?)?$/;
                    
                    if (!isExceptionKey && !dateRegex.test(data[key])) {
                        newData[key] = toTitleCase(data[key]);
                    } else {
                        // Pass through if it's an exception key OR if it's a date string
                        newData[key] = data[key]; 
                    }
                } else if (typeof data[key] === 'object' && data[key] !== null) {
                    newData[key] = transformDataForTitleCasing(data[key]); // Recurse
                } else {
                    newData[key] = data[key]; // Copy other types as-is
                }
            }
        }
        return newData;
    }
    return data; // Return non-object/array data as-is
}

// Middleware to Title Case string values in GET JSON responses
app.use((req, res, next) => {
    if (req.method === 'GET') {
        const originalJson = res.json;
        res.json = function(body) {
            // Ensure we only transform if the original body exists and is an object/array
            const transformedBody = (typeof body === 'object' && body !== null) 
                                  ? transformDataForTitleCasing(body) 
                                  : body;
            originalJson.call(this, transformedBody);
        };
    }
    next();
});

app.get('/', (req, res) => { // Added req parameter
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// --- KPIs, Orders, Stock (Existing, largely unchanged) ---
app.get('/api/kpis', async (req, res) => {
    if (!pool) return res.status(503).json({ error: 'Database not connected' });
    try {
        const request = pool.request();
        const totalBooksResult = await request.query('SELECT COUNT(*) AS TotalBooks FROM dbo.Books');
        const totalOrdersResult = await request.query('SELECT COUNT(*) AS TotalOrders FROM dbo.Orders');
        const totalRevenueResult = await request.query(`
            SELECT SUM(p.Amount) AS TotalRevenue 
            FROM dbo.Payments p
            JOIN dbo.Orders o ON p.OrderID = o.OrderID
            WHERE o.Status = 'Completed' 
        `);
        const revenue = totalRevenueResult.recordset[0].TotalRevenue || 0;
        const totalCustomersResult = await request.query('SELECT COUNT(*) AS TotalCustomers FROM dbo.Customers');
        res.json({
            totalBooks: totalBooksResult.recordset[0].TotalBooks,
            totalOrders: totalOrdersResult.recordset[0].TotalOrders,
            totalRevenue: revenue,
            newCustomers: totalCustomersResult.recordset[0].TotalCustomers
        });
    } catch (err) {
        console.error('Error fetching KPIs:', err);
        res.status(500).json({ error: 'Failed to fetch KPIs', details: err.message });
    }
});

app.get('/api/recent-orders', async (req, res) => {
    if (!pool) return res.status(503).json({ error: 'Database not connected' });
    try {
        const request = pool.request();
        const result = await request.query(`
            SELECT TOP 5 OrderID, CustomerName, OrderDate, TotalAmount, Status 
            FROM dbo.OrderSummary 
            ORDER BY OrderDate DESC, OrderID DESC
        `);
        res.json(result.recordset.map(order => ({ ...order, amount: order.TotalAmount })));
    } catch (err) {
        console.error('Error fetching recent orders:', err);
        res.status(500).json({ error: 'Failed to fetch recent orders', details: err.message });
    }
});

app.get('/api/top-selling-books', async (req, res) => {
    if (!pool) return res.status(503).json({ error: 'Database not connected' });
    try {
        const request = pool.request();
        const result = await request.query(`
            SELECT TOP 5 b.BookID, b.Title, a.Name AS AuthorName, b.Price, b.Stock, tsb.TotalSold, b.Genre, b.Format, b.Language, b.PublicationDate, b.ISBN
            FROM dbo.TopSellingBooks tsb
            JOIN dbo.Books b ON tsb.Title = b.Title 
            JOIN dbo.Authors a ON b.AuthorID = a.AuthorID
            ORDER BY tsb.TotalSold DESC
        `);
        res.json(result.recordset.map(book => ({
            id: book.BookID, title: book.Title, author: book.AuthorName, price: parseFloat(book.Price),
            stock: book.Stock, sales: book.TotalSold, category: book.Genre, format: book.Format,
            language: book.Language, publicationDate: book.PublicationDate, rating: 4.0, reviews: 0,
            isbn: book.ISBN, 
            bookCover: book.ISBN ? `https://covers.openlibrary.org/b/isbn/${book.ISBN}-M.jpg` : 'https://via.placeholder.com/120x180.png?text=No+Cover'
        })));
    } catch (err) {
        console.error('Error fetching top selling books:', err);
        res.status(500).json({ error: 'Failed to fetch top selling books', details: err.message });
    }
});

app.get('/api/all-orders', async (req, res) => {
    if (!pool) return res.status(503).json({ error: 'Database not connected' });
    try {
        const request = pool.request();
        const result = await request.query(`
            SELECT OrderID, CustomerName, OrderDate, TotalAmount, Status 
            FROM dbo.OrderSummary 
            ORDER BY OrderDate DESC, OrderID DESC
        `);
        res.json(result.recordset.map(order => ({ ...order, amount: order.TotalAmount })));
    } catch (err) {
        console.error('Error fetching all orders:', err);
        res.status(500).json({ error: 'Failed to fetch all orders', details: err.message });
    }
});

app.get('/api/low-stock-books/:threshold', async (req, res) => {
    if (!pool) return res.status(503).json({ error: 'Database not connected' });
    try {
        const threshold = parseInt(req.params.threshold) || 10; 
        const request = pool.request();
        request.input('Threshold', sql.Int, threshold);
        const result = await request.query(`
            SELECT BookID, Title, Stock, ISBN 
            FROM dbo.Books 
            WHERE Stock > 0 AND Stock < @Threshold
            ORDER BY Stock ASC
        `);
        const booksWithCovers = result.recordset.map(book => ({
            ...book,
            BookCover: book.ISBN ? `https://covers.openlibrary.org/b/isbn/${book.ISBN}-M.jpg` : 'https://via.placeholder.com/120x180.png?text=No+Cover'
        }));
        res.json(booksWithCovers);
    } catch (err) {
        console.error('Error fetching low stock books:', err);
        res.status(500).json({ error: 'Failed to fetch low stock books', details: err.message });
    }
});

// --- Authors ---
app.get('/api/authors', async (req, res) => { 
    if (!pool) return res.status(503).json({ error: 'Database not connected' });
    try {
        const result = await pool.request().query('SELECT AuthorID, Name, DOB FROM dbo.Authors ORDER BY Name');
        res.json(result.recordset);
    } catch (err) {
        console.error('Error fetching authors:', err);
        res.status(500).json({ error: 'Failed to fetch authors', details: err.message });
    }
});

app.get('/api/authors/search', async (req, res) => {
    console.log('Authors search endpoint hit with query:', req.query);
    
    if (!pool) {
        console.error('Database pool not available');
        return res.status(503).json({ error: 'Database not connected' });
    }
    
    const { criteria, query } = req.query;
    if (!criteria || !query) {
        return res.status(400).json({ error: 'Search criteria and query required.' });
    }
    
    try {
        const request = pool.request();
        let sqlQuery = `SELECT AuthorID, Name, DOB FROM Authors`;
        const queryParam = `%${query}%`;
        
        switch (criteria.toLowerCase()) {
            case 'name': 
                request.input('queryParam', sql.VarChar(sql.MAX), queryParam);
                sqlQuery += ' WHERE Name LIKE @queryParam';
                break;
            case 'id': 
                const authorId = parseInt(query);
                if (isNaN(authorId)) {
                    return res.status(200).json([]);
                }
                request.input('queryParam', sql.Int, authorId);
                sqlQuery += ' WHERE AuthorID = @queryParam';
                break;
            default: 
                return res.status(400).json({ error: 'Invalid search criteria. Use: name or id' });
        }
        
        sqlQuery += ' ORDER BY Name';
        
        console.log('Executing SQL:', sqlQuery);
        const result = await request.query(sqlQuery);
        console.log('Query result:', result.recordset?.length || 0, 'records found');
        
        res.status(200).json(result.recordset || []);
    } catch (err) {
        console.error('Error searching authors:', err);
        res.status(500).json({ error: 'Failed to search authors', details: err.message });
    }
});

app.get('/api/authors/:id', async (req, res) => {
    if (!pool) return res.status(503).json({ error: 'Database not connected' });
    try {
        const authorId = parseInt(req.params.id);
        const request = pool.request();
        request.input('AuthorID', sql.Int, authorId);
        const result = await request.query('SELECT AuthorID, Name, DOB FROM dbo.Authors WHERE AuthorID = @AuthorID');
        if (result.recordset.length === 0) return res.status(404).json({ error: 'Author not found' });
        res.json(result.recordset[0]);
    } catch (err) {
        console.error('Error fetching author:', err);
        res.status(500).json({ error: 'Failed to fetch author', details: err.message });
    }
});

app.post('/api/authors', async (req, res) => { 
    if (!pool) return res.status(503).json({ error: 'Database not connected' });
    try {
        const { name, dob } = req.body;
        if (!name) return res.status(400).json({ error: 'Author name is required' });
        const request = pool.request();
        request.input('Name', sql.VarChar(100), name);
        request.input('DOB', sql.Date, dob || null);
        await request.query(`INSERT INTO dbo.Authors (Name, DOB) VALUES (@Name, @DOB)`);
        res.status(201).json({ message: 'Author added successfully' });
    } catch (err) {
        console.error('Error adding author:', err);
        res.status(500).json({ error: 'Failed to add author', details: err.message });
    }
});

app.put('/api/authors/:id', async (req, res) => {
    if (!pool) return res.status(503).json({ error: 'Database not connected' });
    try {
        const authorId = parseInt(req.params.id);
        const { name, dob } = req.body;
        if (!name) return res.status(400).json({ error: 'Author name is required' });
        const request = pool.request();
        request.input('AuthorID', sql.Int, authorId);
        request.input('Name', sql.VarChar(100), name);
        request.input('DOB', sql.Date, dob || null);
        const result = await request.query(`UPDATE dbo.Authors SET Name = @Name, DOB = @DOB WHERE AuthorID = @AuthorID`);
        if (result.rowsAffected[0] === 0) return res.status(404).json({ error: 'Author not found' });
        res.json({ message: 'Author updated successfully' });
    } catch (err) {
        console.error('Error updating author:', err);
        res.status(500).json({ error: 'Failed to update author', details: err.message });
    }
});

app.delete('/api/authors/:id', async (req, res) => {
    if (!pool) return res.status(503).json({ error: 'Database not connected' });
    try {
        const authorId = parseInt(req.params.id);
        const request = pool.request();
        request.input('AuthorID', sql.Int, authorId);
        const result = await request.query('DELETE FROM dbo.Authors WHERE AuthorID = @AuthorID');
        if (result.rowsAffected[0] === 0) return res.status(404).json({ error: 'Author not found' });
        res.json({ message: 'Author deleted successfully' });
    } catch (err) {
        console.error('Error deleting author:', err);
         if (err.number === 547) return res.status(400).json({ error: 'Cannot delete author. It is referenced by existing books.' });
        res.status(500).json({ error: 'Failed to delete author', details: err.message });
    }
});

// --- Publishers ---
app.get('/api/publishers', async (req, res) => { 
    if (!pool) return res.status(503).json({ error: 'Database not connected' });
    try {
        const result = await pool.request().query('SELECT PublisherID, Name, Address, Contact FROM dbo.Publishers ORDER BY Name');
        res.json(result.recordset);
    } catch (err) {
        console.error('Error fetching publishers:', err);
        res.status(500).json({ error: 'Failed to fetch publishers', details: err.message });
    }
});

app.get('/api/publishers/search', async (req, res) => {
    console.log('Publishers search endpoint hit with query:', req.query);
    
    if (!pool) {
        console.error('Database pool not available');
        return res.status(503).json({ error: 'Database not connected' });
    }
    
    const { criteria, query } = req.query;
    if (!criteria || !query) {
        return res.status(400).json({ error: 'Search criteria and query required.' });
    }
    
    try {
        const request = pool.request();
        let sqlQuery = `SELECT PublisherID, Name, Address, Contact FROM Publishers`;
        const queryParam = `%${query}%`;
        
        switch (criteria.toLowerCase()) {
            case 'name': 
                request.input('queryParam', sql.VarChar(sql.MAX), queryParam);
                sqlQuery += ' WHERE Name LIKE @queryParam';
                break;
            case 'id': 
                const publisherId = parseInt(query);
                if (isNaN(publisherId)) {
                    return res.status(200).json([]);
                }
                request.input('queryParam', sql.Int, publisherId);
                sqlQuery += ' WHERE PublisherID = @queryParam';
                break;
            case 'contact': 
                request.input('queryParam', sql.VarChar(sql.MAX), queryParam);
                sqlQuery += ' WHERE Contact LIKE @queryParam';
                break;
            default: 
                return res.status(400).json({ error: 'Invalid search criteria. Use: name, id, or contact' });
        }
        
        sqlQuery += ' ORDER BY Name';
        
        console.log('Executing SQL:', sqlQuery);
        const result = await request.query(sqlQuery);
        console.log('Query result:', result.recordset?.length || 0, 'records found');
        
        res.status(200).json(result.recordset || []);
    } catch (err) {
        console.error('Error searching publishers:', err);
        res.status(500).json({ error: 'Failed to search publishers', details: err.message });
    }
});

app.get('/api/publishers/:id', async (req, res) => {
    if (!pool) return res.status(503).json({ error: 'Database not connected' });
    try {
        const publisherId = parseInt(req.params.id);
        const request = pool.request();
        request.input('PublisherID', sql.Int, publisherId);
        const result = await request.query('SELECT PublisherID, Name, Address, Contact FROM dbo.Publishers WHERE PublisherID = @PublisherID');
        if (result.recordset.length === 0) return res.status(404).json({ error: 'Publisher not found' });
        res.json(result.recordset[0]);
    } catch (err) {
        console.error('Error fetching publisher:', err);
        res.status(500).json({ error: 'Failed to fetch publisher', details: err.message });
    }
});

app.post('/api/publishers', async (req, res) => { 
    if (!pool) return res.status(503).json({ error: 'Database not connected' });
    try {
        const { name, address, contact } = req.body;
        if (!name) return res.status(400).json({ error: 'Publisher name is required' });
        const request = pool.request();
        request.input('Name', sql.VarChar(100), name);
        request.input('Address', sql.VarChar(255), address || null);
        request.input('Contact', sql.VarChar(100), contact || null);
        await request.query(`INSERT INTO dbo.Publishers (Name, Address, Contact) VALUES (@Name, @Address, @Contact)`);
        res.status(201).json({ message: 'Publisher added successfully' });
    } catch (err) {
        console.error('Error adding publisher:', err);
        res.status(500).json({ error: 'Failed to add publisher', details: err.message });
    }
});

app.put('/api/publishers/:id', async (req, res) => {
    if (!pool) return res.status(503).json({ error: 'Database not connected' });
    try {
        const publisherId = parseInt(req.params.id);
        const { name, address, contact } = req.body;
        if (!name) return res.status(400).json({ error: 'Publisher name is required' });
        const request = pool.request();
        request.input('PublisherID', sql.Int, publisherId);
        request.input('Name', sql.VarChar(100), name);
        request.input('Address', sql.VarChar(255), address || null);
        request.input('Contact', sql.VarChar(100), contact || null);
        const result = await request.query(`UPDATE dbo.Publishers SET Name = @Name, Address = @Address, Contact = @Contact WHERE PublisherID = @PublisherID`);
        if (result.rowsAffected[0] === 0) return res.status(404).json({ error: 'Publisher not found' });
        res.json({ message: 'Publisher updated successfully' });
    } catch (err) {
        console.error('Error updating publisher:', err);
        res.status(500).json({ error: 'Failed to update publisher', details: err.message });
    }
});

app.delete('/api/publishers/:id', async (req, res) => {
    if (!pool) return res.status(503).json({ error: 'Database not connected' });
    try {
        const publisherId = parseInt(req.params.id);
        const request = pool.request();
        request.input('PublisherID', sql.Int, publisherId);
        const result = await request.query('DELETE FROM dbo.Publishers WHERE PublisherID = @PublisherID');
        if (result.rowsAffected[0] === 0) return res.status(404).json({ error: 'Publisher not found' });
        res.json({ message: 'Publisher deleted successfully' });
    } catch (err) {
        console.error('Error deleting publisher:', err);
        if (err.number === 547) return res.status(400).json({ error: 'Cannot delete publisher. It is referenced by existing books.' });
        res.status(500).json({ error: 'Failed to delete publisher', details: err.message });
    }
});

// --- Books ---
app.get('/api/books', async (req, res) => { 
    if (!pool) return res.status(503).json({ error: 'Database not connected' });
    try {
        const request = pool.request();
        const result = await request.query(`
            SELECT
                b.BookID, b.Title,
                a.Name AS AuthorName, b.AuthorID,
                p.Name AS PublisherName, b.PublisherID,
                b.Genre, b.Price, b.Stock, b.Format, b.Language, b.PublicationDate,
                b.ISBN
            FROM dbo.Books b
            JOIN dbo.Authors a ON b.AuthorID = a.AuthorID
            JOIN dbo.Publishers p ON b.PublisherID = p.PublisherID
            ORDER BY b.Title
        `);
        const booksWithCovers = result.recordset.map(book => ({
            ...book,
            BookCover: book.ISBN ? `https://covers.openlibrary.org/b/isbn/${book.ISBN}-M.jpg` : 'https://via.placeholder.com/120x180.png?text=No+Cover'
        }));
        res.json(booksWithCovers);
    } catch (err) {
        console.error('Error fetching books:', err);
        res.status(500).json({ error: 'Failed to fetch books', details: err.message });
    }
});

app.get('/api/books/search', async (req, res) => {
    console.log('Books search endpoint hit with query:', req.query);
    
    if (!pool) {
        console.error('Database pool not available');
        return res.status(503).json({ error: 'Database not connected' });
    }
    
    const { criteria, query } = req.query;
    if (!criteria || !query) {
        return res.status(400).json({ error: 'Search criteria and query are required.' });
    }
    
    try {
        const request = pool.request();
        let sqlQuery = `
            SELECT b.BookID, b.Title, auth.Name AS AuthorName, pub.Name AS PublisherName, 
                   b.AuthorID, b.PublisherID, b.Genre, b.Price, b.Stock, b.Format, 
                   b.Language, b.PublicationDate, b.ISBN 
            FROM Books b 
            LEFT JOIN Authors auth ON b.AuthorID = auth.AuthorID 
            LEFT JOIN Publishers pub ON b.PublisherID = pub.PublisherID`;
        
        const queryParam = `%${query}%`;
        
        switch (criteria.toLowerCase()) {
            case 'title': 
                request.input('queryParam', sql.VarChar(sql.MAX), queryParam);
                sqlQuery += ' WHERE b.Title LIKE @queryParam';
                break;
            case 'author': 
                request.input('queryParam', sql.VarChar(sql.MAX), queryParam);
                sqlQuery += ' WHERE auth.Name LIKE @queryParam';
                break;
            case 'genre': 
                request.input('queryParam', sql.VarChar(sql.MAX), queryParam);
                sqlQuery += ' WHERE b.Genre LIKE @queryParam';
                break;
            case 'id': 
                const bookId = parseInt(query);
                if (isNaN(bookId)) {
                    return res.status(200).json([]);
                }
                request.input('queryParam', sql.Int, bookId);
                sqlQuery += ' WHERE b.BookID = @queryParam';
                break;
            default: 
                return res.status(400).json({ error: 'Invalid search criteria. Use: title, author, genre, or id' });
        }
        
        sqlQuery += ' ORDER BY b.Title';
        
        console.log('Executing SQL:', sqlQuery);
        const result = await request.query(sqlQuery);
        console.log('Query result:', result.recordset?.length || 0, 'records found');
        
        const booksWithCovers = result.recordset.map(book => ({
            ...book,
            BookCover: book.ISBN ? `https://covers.openlibrary.org/b/isbn/${book.ISBN}-M.jpg` : 'https://via.placeholder.com/120x180.png?text=No+Cover'
        }));
        res.status(200).json(booksWithCovers || []);
    } catch (err) {
        console.error('Error searching books:', err);
        res.status(500).json({ error: 'Failed to search books', details: err.message });
    }
});

app.get('/api/books/in-stock', async (req, res) => { 
    if (!pool) return res.status(503).json({ error: 'Database not connected' });
    try {
        const request = pool.request();
        const result = await request.query('SELECT BookID, Title, Stock, Price, ISBN FROM dbo.Books WHERE Stock > 0 ORDER BY Title');
        const booksWithCovers = result.recordset.map(book => ({
            ...book,
            BookCover: book.ISBN ? `https://covers.openlibrary.org/b/isbn/${book.ISBN}-M.jpg` : 'https://via.placeholder.com/120x180.png?text=No+Cover'
        }));
        res.json(booksWithCovers);
    } catch (err) {
        console.error('Error fetching books in stock:', err);
        res.status(500).json({ error: 'Failed to fetch books in stock', details: err.message });
    }
});

app.get('/api/books/:id', async (req, res) => { 
    if (!pool) return res.status(503).json({ error: 'Database not connected' });
    try {
        const bookId = parseInt(req.params.id);
        const request = pool.request();
        request.input('BookID', sql.Int, bookId);
        const result = await request.query(`
            SELECT b.BookID, b.Title, b.AuthorID, auth.Name as AuthorName, 
                   b.PublisherID, pub.Name as PublisherName, b.Genre, b.Price, 
                   b.Stock, b.Format, b.Language, b.PublicationDate,
                   b.ISBN
            FROM dbo.Books b
            LEFT JOIN dbo.Authors auth ON b.AuthorID = auth.AuthorID
            LEFT JOIN dbo.Publishers pub ON b.PublisherID = pub.PublisherID
            WHERE b.BookID = @BookID
        `);
        if (result.recordset.length === 0) {
            return res.status(404).json({ error: 'Book not found' });
        }
        const book = result.recordset[0];
        const bookWithCover = {
            ...book,
            BookCover: book.ISBN ? `https://covers.openlibrary.org/b/isbn/${book.ISBN}-M.jpg` : 'https://via.placeholder.com/120x180.png?text=No+Cover'
        };
        res.json(bookWithCover);
    } catch (err) {
        console.error('Error fetching book details:', err);
        res.status(500).json({ error: 'Failed to fetch book details', details: err.message });
    }
});

app.post('/api/books', async (req, res) => { 
    if (!pool) return res.status(503).json({ error: 'Database not connected' });
    try {
        const { title, authorId, publisherId, genre, price, stock, format, language, publicationDate, isbn, bookCover } = req.body;
        if (!title || authorId == null || publisherId == null || price == null || stock == null || !format || !publicationDate) {
            return res.status(400).json({ error: 'Missing required book fields.' });
        }
        const request = pool.request();
        request.input('Title', sql.VarChar(200), title);
        request.input('AuthorID', sql.Int, parseInt(authorId));
        request.input('PublisherID', sql.Int, parseInt(publisherId));
        request.input('Genre', sql.VarChar(100), genre || null); 
        request.input('Price', sql.Decimal(10, 2), parseFloat(price));
        request.input('Stock', sql.Int, parseInt(stock));
        request.input('Format', sql.VarChar(50), format);
        request.input('Language', sql.VarChar(50), language || null); 
        request.input('PublicationDate', sql.Date, publicationDate);
        request.input('ISBN', sql.VarChar(17), isbn || null);
        // Note: BookCover is not stored in DB, it's derived from ISBN
        
        await request.execute('dbo.InsertBook');
        res.status(201).json({ message: 'Book added successfully' });
    } catch (err) {
        console.error('Error adding book:', err);
        if (err.number === 547 || err.message.includes('CHECK constraint') || err.message.includes('FOREIGN KEY constraint')) {
             res.status(400).json({ error: `Data conflict: ${err.message}` });
        } else {
             res.status(500).json({ error: 'Failed to add book.', details: err.message });
        }
    }
});

app.put('/api/books/:id', async (req, res) => { 
    if (!pool) return res.status(503).json({ error: 'Database not connected' });
    try {
        const bookId = parseInt(req.params.id);
        const { title, authorId, publisherId, genre, price, stock, format, language, publicationDate, isbn, bookCover } = req.body;
        if (!title || authorId == null || publisherId == null || price == null || stock == null || !format || !publicationDate) {
            return res.status(400).json({ error: 'Missing required fields for update.' });
        }
        const request = pool.request();
        request.input('BookID', sql.Int, bookId);
        request.input('Title', sql.VarChar(200), title);
        request.input('AuthorID', sql.Int, parseInt(authorId));
        request.input('PublisherID', sql.Int, parseInt(publisherId));
        request.input('Genre', sql.VarChar(100), genre || null);
        request.input('Price', sql.Decimal(10, 2), parseFloat(price));
        request.input('Stock', sql.Int, parseInt(stock));
        request.input('Format', sql.VarChar(50), format);
        request.input('Language', sql.VarChar(50), language || null);
        request.input('PublicationDate', sql.Date, publicationDate);
        request.input('ISBN', sql.VarChar(17), isbn || null);
        // Note: BookCover is not stored in DB, it's derived from ISBN
        
        const result = await request.query(`
            UPDATE dbo.Books SET
                Title = @Title, AuthorID = @AuthorID, PublisherID = @PublisherID, Genre = @Genre,
                Price = @Price, Stock = @Stock, Format = @Format, Language = @Language,
                PublicationDate = @PublicationDate, ISBN = @ISBN
            WHERE BookID = @BookID
        `);
        if (result.rowsAffected[0] === 0) return res.status(404).json({ error: 'Book not found or no changes made.' });
        res.json({ message: 'Book updated successfully' });
    } catch (err) {
        console.error('Error updating book:', err);
        res.status(500).json({ error: 'Failed to update book', details: err.message });
    }
});

app.delete('/api/books/:id', async (req, res) => { 
    if (!pool) return res.status(503).json({ error: 'Database not connected' });
    try {
        const bookId = parseInt(req.params.id);
        if (isNaN(bookId)) return res.status(400).json({ error: 'Invalid Book ID.' });
        const request = pool.request();
        request.input('BookID', sql.Int, bookId);
        const result = await request.query('DELETE FROM dbo.Books WHERE BookID = @BookID');
        if (result.rowsAffected[0] === 0) return res.status(404).json({ error: 'Book not found.' });
        res.json({ message: 'Book deleted successfully' });
    } catch (err) {
        console.error('Error deleting book:', err);
        if (err.number === 547) return res.status(400).json({ error: 'Cannot delete book. It is referenced in existing records.'});
        res.status(500).json({ error: 'Failed to delete book', details: err.message });
    }
});

app.put('/api/books/:id/stock', async (req, res) => { 
    if (!pool) return res.status(503).json({ error: 'Database not connected' });
    try {
        const bookId = parseInt(req.params.id);
        const { stockChange } = req.body;
        if (isNaN(bookId) || stockChange == null || isNaN(stockChange)) {
            return res.status(400).json({ error: 'Valid book ID and stock change are required' });
        }
        const request = pool.request();
        request.input('BookID', sql.Int, bookId);
        request.input('StockChange', sql.Int, parseInt(stockChange));
        await request.execute('dbo.UpdateBookStock');
        const stockResult = await pool.request().input('BookIDCheck', sql.Int, bookId)
            .query('SELECT Stock FROM dbo.Books WHERE BookID = @BookIDCheck');
        if (stockResult.recordset.length === 0) return res.status(404).json({ error: 'Book not found' });
        res.json({ message: 'Stock updated successfully', newStock: stockResult.recordset[0].Stock });
    } catch (err) {
        console.error('Error updating book stock:', err);
        res.status(500).json({ error: 'Failed to update stock', details: err.message });
    }
});

// --- Customers ---
app.get('/api/customers', async (req, res) => { 
    if (!pool) return res.status(503).json({ error: 'Database not connected' });
    try {
        const request = pool.request();
        const result = await request.query(`
            SELECT c.CustomerID, c.FirstName, c.LastName, c.Email, c.Phone, c.ShippingAddress, c.BillingAddress,
                   (SELECT COUNT(o.OrderID) FROM dbo.Orders o WHERE o.CustomerID = c.CustomerID) AS TotalOrders
            FROM dbo.Customers c ORDER BY c.LastName, c.FirstName
        `);
        res.json(result.recordset);
    } catch (err) {
        console.error('Error fetching customers:', err);
        res.status(500).json({ error: 'Failed to fetch customers', details: err.message });
    }
});

app.get('/api/customers/search', async (req, res) => {
    console.log('Customers search endpoint hit with query:', req.query);
    
    if (!pool) {
        console.error('Database pool not available');
        return res.status(503).json({ error: 'Database not connected' });
    }
    
    const { criteria, query } = req.query;
    if (!criteria || !query) {
        return res.status(400).json({ error: 'Search criteria and query are required.' });
    }
    
    try {
        const request = pool.request();
        let sqlQuery = `
            SELECT c.CustomerID, c.FirstName, c.LastName, c.Email, c.Phone, 
                   (SELECT COUNT(o.OrderID) FROM Orders o WHERE o.CustomerID = c.CustomerID) AS TotalOrders 
            FROM Customers c`;
        
        const queryParam = `%${query}%`;

        switch (criteria.toLowerCase()) {
            case 'name': 
                request.input('queryParam', sql.VarChar(sql.MAX), queryParam);
                sqlQuery += ` WHERE (c.FirstName LIKE @queryParam OR c.LastName LIKE @queryParam OR 
                             CONCAT(c.FirstName, ' ', c.LastName) LIKE @queryParam)`;
                break;
            case 'email': 
                request.input('queryParam', sql.VarChar(sql.MAX), queryParam);
                sqlQuery += ' WHERE c.Email LIKE @queryParam';
                break;
            case 'id': 
                const customerId = parseInt(query);
                if (isNaN(customerId)) {
                    return res.status(200).json([]);
                }
                request.input('queryParam', sql.Int, customerId);
                sqlQuery += ' WHERE c.CustomerID = @queryParam';
                break;
            default: 
                return res.status(400).json({ error: 'Invalid search criteria. Use: name, email, or id' });
        }
        
        sqlQuery += ' ORDER BY c.LastName, c.FirstName';
        
        console.log('Executing SQL:', sqlQuery);
        const result = await request.query(sqlQuery);
        console.log('Query result:', result.recordset?.length || 0, 'records found');
        
        res.status(200).json(result.recordset || []);
    } catch (err) {
        console.error('Error searching customers:', err);
        res.status(500).json({ error: 'Failed to search customers', details: err.message });
    }
});

app.get('/api/customers/:id', async (req, res) => {
    if (!pool) return res.status(503).json({ error: 'Database not connected' });
    try {
        const customerId = parseInt(req.params.id);
        const request = pool.request();
        request.input('CustomerID', sql.Int, customerId);
        const result = await request.query('SELECT * FROM dbo.Customers WHERE CustomerID = @CustomerID');
        if (result.recordset.length === 0) return res.status(404).json({ error: 'Customer not found' });
        res.json(result.recordset[0]);
    } catch (err) {
        console.error('Error fetching customer:', err);
        res.status(500).json({ error: 'Failed to fetch customer', details: err.message });
    }
});

app.post('/api/customers', async (req, res) => { 
    if (!pool) return res.status(503).json({ error: 'Database not connected' });
    try {
        const { firstName, lastName, email, phone, password, shippingAddress, billingAddress } = req.body;
        if (!firstName || !lastName || !email) {
            return res.status(400).json({ error: 'First name, last name, and email are required' });
        }
        const request = pool.request();
        request.input('FirstName', sql.VarChar(100), firstName);
        request.input('LastName', sql.VarChar(100), lastName);
        request.input('Email', sql.VarChar(100), email);
        request.input('Phone', sql.VarChar(20), phone || null);
        request.input('Password', sql.VarChar(255), password || null); 
        request.input('ShippingAddress', sql.VarChar(255), shippingAddress || null);
        request.input('BillingAddress', sql.VarChar(255), billingAddress || null);
        await request.execute('dbo.AddCustomer');
        res.status(201).json({ message: 'Customer added successfully' });
    } catch (err) {
        console.error('Error adding customer:', err);
        if (err.message.toLowerCase().includes('unique constraint') || err.message.toLowerCase().includes('duplicate key') || err.number === 2627) {
            res.status(400).json({ error: 'Email already exists.' });
        } else {
            res.status(500).json({ error: 'Failed to add customer', details: err.message });
        }
    }
});

app.put('/api/customers/:id', async (req, res) => {
    if (!pool) return res.status(503).json({ error: 'Database not connected' });
    try {
        const customerId = parseInt(req.params.id);
        const { firstName, lastName, email, phone, password, shippingAddress, billingAddress } = req.body;
        if (!firstName || !lastName || !email) return res.status(400).json({ error: 'First name, last name, email required' });

        const request = pool.request();
        request.input('CustomerID', sql.Int, customerId);
        request.input('FirstName', sql.VarChar(100), firstName);
        request.input('LastName', sql.VarChar(100), lastName);
        request.input('Email', sql.VarChar(100), email);
        request.input('Phone', sql.VarChar(20), phone || null);
        request.input('ShippingAddress', sql.VarChar(255), shippingAddress || null);
        request.input('BillingAddress', sql.VarChar(255), billingAddress || null);

        let query = `UPDATE dbo.Customers SET FirstName = @FirstName, LastName = @LastName, Email = @Email, Phone = @Phone, ShippingAddress = @ShippingAddress, BillingAddress = @BillingAddress`;
        if (password) { 
            request.input('Password', sql.VarChar(255), password); 
            query += `, Password = @Password`;
        }
        query += ` WHERE CustomerID = @CustomerID`;
        
        const result = await request.query(query);
        if (result.rowsAffected[0] === 0) return res.status(404).json({ error: 'Customer not found' });
        res.json({ message: 'Customer updated successfully' });
    } catch (err) {
        console.error('Error updating customer:', err);
        if (err.message.toLowerCase().includes('unique constraint') || err.message.toLowerCase().includes('duplicate key') || err.number === 2627) {
            res.status(400).json({ error: 'Email already exists for another customer.' });
        } else {
            res.status(500).json({ error: 'Failed to update customer', details: err.message });
        }
    }
});

app.delete('/api/customers/:id', async (req, res) => {
    if (!pool) return res.status(503).json({ error: 'Database not connected' });
    try {
        const customerId = parseInt(req.params.id);
        const request = pool.request();
        request.input('CustomerID', sql.Int, customerId);
        const ordersCheck = await request.query('SELECT COUNT(*) as OrderCount FROM dbo.Orders WHERE CustomerID = @CustomerID');
        if (ordersCheck.recordset[0].OrderCount > 0) {
            return res.status(400).json({ error: 'Cannot delete customer with existing orders. Consider deactivating instead.' });
        }
        const result = await request.query('DELETE FROM dbo.Customers WHERE CustomerID = @CustomerID');
        if (result.rowsAffected[0] === 0) return res.status(404).json({ error: 'Customer not found' });
        res.json({ message: 'Customer deleted successfully' });
    } catch (err) {
        console.error('Error deleting customer:', err);
        res.status(500).json({ error: 'Failed to delete customer', details: err.message });
    }
});

app.get('/api/customers/:id/orders', async (req, res) => { 
    if (!pool) return res.status(503).json({ error: 'Database not connected' });
    try {
        const customerId = parseInt(req.params.id);
        if (isNaN(customerId)) return res.status(400).json({ error: 'Valid customer ID is required' });
        const request = pool.request();
        request.input('CustomerID', sql.Int, customerId);
        const result = await request.query(`SELECT * FROM dbo.CustomerOrders WHERE CustomerID = @CustomerID ORDER BY OrderDate DESC`);
        res.json(result.recordset);
    } catch (err) {
        console.error('Error fetching customer orders:', err);
        res.status(500).json({ error: 'Failed to fetch customer orders', details: err.message });
    }
});

// --- Orders ---
app.post('/api/orders', async (req, res) => { 
    if (!pool) return res.status(503).json({ error: 'Database not connected' });
    try {
        const { customerId, items, paymentMethod } = req.body;
        if (!customerId || !items || !Array.isArray(items) || items.length === 0 || !paymentMethod) {
            return res.status(400).json({ error: 'Customer ID, items array, and payment method are required' });
        }
        const validPaymentMethods = ['Cash', 'Card', 'JazzCash', 'EasyPaisa', 'SadaPay'];
        if (!validPaymentMethods.includes(paymentMethod)) {
            return res.status(400).json({ error: `Invalid payment method. Must be one of: ${validPaymentMethods.join(', ')}` });
        }
        for (const item of items) {
            if (!item.bookId || !item.quantity || item.quantity <= 0) {
                return res.status(400).json({ error: 'Each item must have bookId and quantity > 0' });
            }
        }
        const request = pool.request();
        request.input('CustomerID', sql.Int, parseInt(customerId));
        request.input('PaymentMethod', sql.VarChar(50), paymentMethod);
        const bookIds = new sql.Table(); bookIds.columns.add('Value', sql.Int);
        const quantities = new sql.Table(); quantities.columns.add('Value', sql.Int);
        items.forEach(item => { bookIds.rows.add(parseInt(item.bookId)); quantities.rows.add(parseInt(item.quantity)); });
        request.input('BookIDs', bookIds);
        request.input('Quantities', quantities);
        await request.execute('dbo.PlaceOrder');
        res.status(201).json({ message: 'Order placed successfully' });
    } catch (err) {
        console.error('Error placing order:', err);
        if (err.message.includes('insufficient stock') || err.number === 547) {
            res.status(400).json({ error: 'Insufficient stock or data conflict.' });
        } else {
            res.status(500).json({ error: 'Failed to place order', details: err.message });
        }
    }
});

app.get('/api/orders/:id/details', async (req, res) => { 
    if (!pool) return res.status(503).json({ error: 'Database not connected' });
    try {
        const orderId = parseInt(req.params.id);
        if (isNaN(orderId)) return res.status(400).json({ error: 'Valid order ID is required' });
        const request = pool.request();
        request.input('OrderID', sql.Int, orderId);
        const result = await request.query(`
            SELECT od.OrderDetailID, od.OrderID, od.BookID, b.Title, a.Name AS AuthorName, od.Quantity, b.Price, (od.Quantity * b.Price) AS LineTotal
            FROM dbo.OrderDetails od JOIN dbo.Books b ON od.BookID = b.BookID JOIN dbo.Authors a ON b.AuthorID = a.AuthorID
            WHERE od.OrderID = @OrderID
        `);
        res.json(result.recordset);
    } catch (err) {
        console.error('Error fetching order details:', err);
        res.status(500).json({ error: 'Failed to fetch order details', details: err.message });
    }
});

app.put('/api/orders/:id/status', async (req, res) => { 
    if (!pool) return res.status(503).json({ error: 'Database not connected' });
    try {
        const orderId = parseInt(req.params.id);
        const { status } = req.body;
        if (isNaN(orderId) || !status) return res.status(400).json({ error: 'Valid order ID and status are required' });
        const request = pool.request();
        request.input('OrderID', sql.Int, orderId);
        request.input('Status', sql.VarChar(50), status);
        await request.query(`UPDATE dbo.Orders SET Status = @Status WHERE OrderID = @OrderID`);
        res.json({ message: 'Order status updated successfully' });
    } catch (err) {
        console.error('Error updating order status:', err);
        res.status(500).json({ error: 'Failed to update order status', details: err.message });
    }
});

// --- Genres ---
app.get('/api/genres', async (req, res) => {
    if (!pool) return res.status(503).json({ error: 'Database not connected' });
    try {
        const request = pool.request();
        const result = await request.query("SELECT DISTINCT Genre AS Name, ROW_NUMBER() OVER (ORDER BY Genre) as GenreID FROM dbo.Books WHERE Genre IS NOT NULL AND Genre <> '' ORDER BY Genre");
        res.json(result.recordset);
    } catch (err) {
        console.error('Error fetching genres:', err);
        res.status(500).json({ error: 'Failed to fetch genres', details: err.message });
    }
});

app.post('/api/genres', async (req, res) => { 
    if (!pool) return res.status(503).json({ error: 'Database not connected or Genres table does not exist as assumed.' });
    try {
        const { id, name } = req.body;
        if (!name) return res.status(400).json({ error: 'Genre name required' });
        const request = pool.request();
        request.input('Name', sql.VarChar(100), name);
        
        let checkQuery = "SELECT GenreID FROM dbo.Genres WHERE Name = @Name";
        if (id) checkQuery += " AND GenreID <> @GenreID";
        if (id) request.input('GenreID_check', sql.Int, id);
        
        const existing = await request.query(checkQuery);
        if (existing.recordset.length > 0) {
            return res.status(409).json({ error: 'Genre name already exists.' });
        }

        if (id) { 
            request.input('GenreID', sql.Int, id);
            await request.query('UPDATE dbo.Genres SET Name = @Name WHERE GenreID = @GenreID');
        } else { 
            await request.query('INSERT INTO dbo.Genres (Name) VALUES (@Name)');
        }
        res.status(id ? 200 : 201).json({ message: `Genre ${id ? 'updated' : 'added'} successfully` });
    } catch (err) {
        console.error('Error saving genre:', err);
        if (err.number === 2627 || err.number === 2601) { 
             return res.status(409).json({ error: 'Genre name already exists (DB constraint).' });
        }
        res.status(500).json({ error: 'Database error saving genre', details: err.message });
    }
});

app.delete('/api/genres/:id', async (req, res) => { 
    if (!pool) return res.status(503).json({ error: 'Database not connected or Genres table not structured as assumed.' });
    try {
        const genreId = parseInt(req.params.id);
        if (isNaN(genreId)) return res.status(400).json({ error: 'Invalid Genre ID.' });

        const request = pool.request();
        request.input('GenreID', sql.Int, genreId);

        const genreNameResult = await request.query("SELECT Name FROM dbo.Genres WHERE GenreID = @GenreID");
        if (genreNameResult.recordset.length === 0) {
            return res.status(404).json({ error: 'Genre not found.' });
        }
        const genreName = genreNameResult.recordset[0].Name;
        
        request.input('GenreNameUsage', sql.NVarChar, genreName);
        const usageCheck = await request.query("SELECT COUNT(*) as count FROM dbo.Books WHERE Genre = @GenreNameUsage");
        
        if (usageCheck.recordset[0].count > 0) {
            return res.status(400).json({ error: 'Cannot delete genre. It is currently assigned to one or more books.' });
        }
        const deleteResult = await request.query('DELETE FROM dbo.Genres WHERE GenreID = @GenreID');
        if (deleteResult.rowsAffected[0] === 0) return res.status(404).json({ error: 'Genre not found or already deleted.' });

        res.json({ message: 'Genre deleted successfully' });
    } catch (err) {
        console.error('Error deleting genre:', err);
        res.status(500).json({ error: 'Database error deleting genre', details: err.message });
    }
});


// ------------------------
// --- Search Endpoints ---
// ------------------------

app.get('/api/genres/search', async (req, res) => {
    console.log('Genres search endpoint hit with query:', req.query);
    
    if (!pool) {
        console.error('Database pool not available');  
        return res.status(503).json({ error: 'Database not connected' });
    }
    
    const { name } = req.query;
    if (!name) {
        return res.status(400).json({ error: 'Genre name for search is required.' });
    }
    
    try {
        const request = pool.request();
        request.input('queryParam', sql.VarChar(sql.MAX), `%${name}%`);
        const result = await request.query(`
            SELECT GenreID, Name FROM dbo.Genres WHERE Name LIKE @queryParam
        `);
        res.status(200).json(result.recordset);
    } catch (err) {
        console.error('Error searching genres:', err);
        res.status(500).json({ error: 'Failed to search genres', details: err.message });
    }
});

// ------------------------
// --- NOTIFI Endpoints ---
// ------------------------

const NOTIFICATIONS_FILE_PATH = path.join(__dirname, 'notifications.json');

async function readNotificationsFile() {
    try {
        await fs.access(NOTIFICATIONS_FILE_PATH); 
        const data = await fs.readFile(NOTIFICATIONS_FILE_PATH, 'utf-8');
        const jsonData = JSON.parse(data);
        return {
            unread: Array.isArray(jsonData.unread) ? jsonData.unread : [],
            read: Array.isArray(jsonData.read) ? jsonData.read : []
        };
    } catch (error) {
        if (error.code === 'ENOENT') {
            console.log('notifications.json not found, creating a new one.');
            const emptyNotifications = { unread: [], read: [] };
            await writeNotificationsFile(emptyNotifications);
            return emptyNotifications;
        }
        console.error('Error reading notifications.json:', error);
        return { unread: [], read: [] }; 
    }
}

async function writeNotificationsFile(data) {
    try {
        const dataToWrite = {
            unread: Array.isArray(data.unread) ? data.unread : [],
            read: Array.isArray(data.read) ? data.read : []
        };
        await fs.writeFile(NOTIFICATIONS_FILE_PATH, JSON.stringify(dataToWrite, null, 2), 'utf-8');
    } catch (error) {
        console.error('Error writing to notifications.json:', error);
    }
}

app.get('/api/notifications', async (req, res) => {
    if (!pool) return res.status(503).json({ error: 'Database not connected, but notifications are file-based.' });
    try {
        const notifications = await readNotificationsFile();
        notifications.unread.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));
        notifications.read.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));
        res.json(notifications);
    } catch (error) {
        console.error('Error fetching notifications:', error);
        res.status(500).json({ error: 'Failed to fetch notifications', details: error.message });
    }
});

app.post('/api/notifications', async (req, res) => {
    if (!pool) return res.status(503).json({ error: 'Database not connected, but notifications are file-based.' });
    try {
        const newNotification = req.body; 
        if (!newNotification.id || !newNotification.headline || !newNotification.message || !newNotification.timestamp) {
            return res.status(400).json({ error: 'Missing required notification fields (id, headline, message, timestamp).' });
        }

        const notifications = await readNotificationsFile();
        
        if (newNotification.read) {
            notifications.read.unshift(newNotification); 
        } else {
            notifications.unread.unshift(newNotification);
        }
        
        const MAX_NOTIFICATIONS_PER_CATEGORY = 100; 
        if (notifications.unread.length > MAX_NOTIFICATIONS_PER_CATEGORY) {
            notifications.unread = notifications.unread.slice(0, MAX_NOTIFICATIONS_PER_CATEGORY);
        }
        if (notifications.read.length > MAX_NOTIFICATIONS_PER_CATEGORY) {
            notifications.read = notifications.read.slice(0, MAX_NOTIFICATIONS_PER_CATEGORY);
        }

        await writeNotificationsFile(notifications);
        res.status(201).json(newNotification);
    } catch (error) {
        console.error('Error adding notification:', error);
        res.status(500).json({ error: 'Failed to add notification', details: error.message });
    }
});

app.put('/api/notifications/:id/status', async (req, res) => {
    if (!pool) return res.status(503).json({ error: 'Database not connected, but notifications are file-based.' });
    try {
        const notificationId = req.params.id;
        const { read } = req.body; 

        if (typeof read !== 'boolean') {
            return res.status(400).json({ error: 'Invalid "read" status provided. Must be true or false.' });
        }

        const notifications = await readNotificationsFile();
        let foundAndUpdated = false;
        let targetList = read ? notifications.read : notifications.unread;
        let sourceList = read ? notifications.unread : notifications.read;

        const indexInSource = sourceList.findIndex(n => n.id === notificationId);
        if (indexInSource > -1) {
            const notification = sourceList.splice(indexInSource, 1)[0];
            notification.read = read;
            targetList.unshift(notification); 
            targetList.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));
            foundAndUpdated = true;
        }
        
        if (foundAndUpdated) {
            await writeNotificationsFile(notifications);
            res.json({ message: `Notification ${notificationId} status updated.` });
        } else {
            const alreadyInTarget = targetList.find(n => n.id === notificationId);
            if (alreadyInTarget) {
                return res.json({ message: `Notification ${notificationId} status already as requested.` });
            }
            res.status(404).json({ error: `Notification ${notificationId} not found.` });
        }
    } catch (error) {
        console.error('Error updating notification status:', error);
        res.status(500).json({ error: 'Failed to update notification status', details: error.message });
    }
});

app.put('/api/notifications/mark-all-read', async (req, res) => {
    if (!pool) return res.status(503).json({ error: 'Database not connected, but notifications are file-based.' });
    try {
        const notifications = await readNotificationsFile();
        if (notifications.unread.length > 0) {
            notifications.unread.forEach(n => n.read = true);
            notifications.read = [...notifications.unread, ...notifications.read];
            notifications.read.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));
            notifications.unread = [];
            await writeNotificationsFile(notifications);
        }
        res.json({ message: 'All unread notifications marked as read.' });
    } catch (error) {
        console.error('Error marking all notifications as read:', error);
        res.status(500).json({ error: 'Failed to mark all as read', details: error.message });
    }
});


app.delete('/api/notifications/:id', async (req, res) => {
    if (!pool) return res.status(503).json({ error: 'Database not connected, but notifications are file-based.' });
    try {
        const notificationId = req.params.id;
        const notifications = await readNotificationsFile();
        
        let initialLength = notifications.unread.length + notifications.read.length;
        notifications.unread = notifications.unread.filter(n => n.id !== notificationId);
        notifications.read = notifications.read.filter(n => n.id !== notificationId);
        let finalLength = notifications.unread.length + notifications.read.length;

        if (initialLength > finalLength) {
            await writeNotificationsFile(notifications);
            res.json({ message: `Notification ${notificationId} deleted.` });
        } else {
            res.status(404).json({ error: `Notification ${notificationId} not found.` });
        }
    } catch (error) {
        console.error('Error deleting notification:', error);
        res.status(500).json({ error: 'Failed to delete notification', details: error.message });
    }
});


// ------------------------
// --- Helper Functions ---
// ------------------------

async function connectDb() {
    try {
        console.log('Attempting to connect to database...');
        pool = await new sql.ConnectionPool(dbConfig).connect();
        console.log(`Connected to database "${process.env.DB_DATABASE}" successfully!`);
        pool.on('error', err => {
            console.error('Database pool error:', err);
        });
    } catch (err) {
        console.error('Database connection failed:', err);
        process.exit(1);
    }
}


// ------------------------
// --- Server Setup ---
// ------------------------

connectDb().then(() => {
    app.listen(port, () => {
        console.log(`Server is running on port http://localhost:${port}`);
    });
});
