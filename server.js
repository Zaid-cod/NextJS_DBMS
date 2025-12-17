require('dotenv').config();
const express = require('express');
const mysql = require('mysql2/promise');
const path = require('path');
const fs = require('fs').promises;

const app = express();
const port = process.env.PORT || 3000;

// MySQL Connection Pool
let pool;

async function connectDb() {
    try {
        console.log('Attempting to connect to database...');
        pool = mysql.createPool({
            host: process.env.DB_HOST,
            user: process.env.DB_USER,
            password: process.env.DB_PASSWORD,
            database: process.env.DB_NAME,
            port: process.env.DB_PORT || 3306,
            waitForConnections: true,
            connectionLimit: 10,
            queueLimit: 0
        });
        
        // Test connection
        const connection = await pool.getConnection();
        console.log(`Connected to database "${process.env.DB_NAME}" successfully!`);
        connection.release();
    } catch (err) {
        console.error('Database connection failed:', err);
        process.exit(1);
    }
}

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Middleware to lowercase string values in req.body for POST and PUT requests
app.use((req, res, next) => {
    if ((req.method === 'POST' || req.method === 'PUT') && req.body) {
        const exceptions = [
            'password', 'adminpass', 'format', 'paymentmethod', 'status',
            'email', 'isbn'
        ];
        for (const key in req.body) {
            if (Object.prototype.hasOwnProperty.call(req.body, key) && typeof req.body[key] === 'string') {
                if (!exceptions.includes(key.toLowerCase())) {
                    req.body[key] = req.body[key].toLowerCase();
                }
            }
        }
    }
    next();
});

app.use(express.static(path.join(__dirname, 'public')));

// Helper function to convert string to Title Case
function toTitleCase(str) {
    if (!str || typeof str !== 'string') return str;
    return str.toLowerCase().split(' ').map(word => {
        return word.charAt(0).toUpperCase() + word.slice(1);
    }).join(' ');
}

const titleCaseExceptions = [
    'password', 'adminpass', 'email', 'isbn', 'bookcover',
    'format', 'paymentmethod', 'status', 'language', 'code',
    'timestamp', 'date', 'createddate', 'orderdate', 'publicationdate',
    'paymentdate', 'lastlogindate', 'updateddate',
    'url', 'uri', 'path', 'href'
];

function transformDataForTitleCasing(data) {
    if (Array.isArray(data)) {
        return data.map(item => transformDataForTitleCasing(item));
    } else if (typeof data === 'object' && data !== null) {
        const newData = {};
        for (const key in data) {
            if (Object.prototype.hasOwnProperty.call(data, key)) {
                const lowerKey = key.toLowerCase();
                const isExceptionKey = titleCaseExceptions.includes(lowerKey) ||
                    lowerKey.endsWith('id') || lowerKey.endsWith('url') ||
                    lowerKey.endsWith('uri') || lowerKey.endsWith('path');

                if (typeof data[key] === 'string') {
                    const dateRegex = /^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}:\d{2}(\.\d{3})?Z?|\s\d{2}:\d{2}:\d{2}(\.\d{3})?)?$/;

                    if (!isExceptionKey && !dateRegex.test(data[key])) {
                        newData[key] = toTitleCase(data[key]);
                    } else {
                        newData[key] = data[key];
                    }
                } else if (typeof data[key] === 'object' && data[key] !== null) {
                    newData[key] = transformDataForTitleCasing(data[key]);
                } else {
                    newData[key] = data[key];
                }
            }
        }
        return newData;
    }
    return data;
}

// Middleware to Title Case string values in GET JSON responses
app.use((req, res, next) => {
    if (req.method === 'GET') {
        const originalJson = res.json;
        res.json = function (body) {
            const transformedBody = (typeof body === 'object' && body !== null)
                ? transformDataForTitleCasing(body)
                : body;
            originalJson.call(this, transformedBody);
        };
    }
    next();
});

app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// --- KPIs ---
app.get('/api/kpis', async (req, res) => {
    if (!pool) return res.status(503).json({ error: 'Database not connected' });
    try {
        const [totalBooksResult] = await pool.query('SELECT COUNT(*) AS TotalBooks FROM Books');
        const [totalOrdersResult] = await pool.query('SELECT COUNT(*) AS TotalOrders FROM Orders');
        const [totalRevenueResult] = await pool.query(`
            SELECT SUM(p.Amount) AS TotalRevenue 
            FROM Payments p
            JOIN Orders o ON p.OrderID = o.OrderID
            WHERE o.Status = 'Completed'
        `);
        const revenue = totalRevenueResult[0].TotalRevenue || 0;
        const [totalCustomersResult] = await pool.query('SELECT COUNT(*) AS TotalCustomers FROM Customers');

        res.json({
            totalBooks: totalBooksResult[0].TotalBooks,
            totalOrders: totalOrdersResult[0].TotalOrders,
            totalRevenue: revenue,
            newCustomers: totalCustomersResult[0].TotalCustomers
        });
    } catch (err) {
        console.error('Error fetching KPIs:', err);
        res.status(500).json({ error: 'Failed to fetch KPIs', details: err.message });
    }
});

app.get('/api/recent-orders', async (req, res) => {
    if (!pool) return res.status(503).json({ error: 'Database not connected' });
    try {
        const [result] = await pool.query(`
            SELECT OrderID, CustomerName, OrderDate, TotalAmount, Status 
            FROM OrderSummary 
            ORDER BY OrderDate DESC, OrderID DESC
            LIMIT 5
        `);
        res.json(result.map(order => ({ ...order, amount: order.TotalAmount })));
    } catch (err) {
        console.error('Error fetching recent orders:', err);
        res.status(500).json({ error: 'Failed to fetch recent orders', details: err.message });
    }
});

app.get('/api/top-selling-books', async (req, res) => {
    if (!pool) return res.status(503).json({ error: 'Database not connected' });
    try {
        const [result] = await pool.query(`
            SELECT b.BookID, b.Title, a.Name AS AuthorName, b.Price, b.Stock, 
                   SUM(od.Quantity) AS TotalSold, b.Genre, b.Format, b.Language, 
                   b.PublicationDate, b.ISBN
            FROM Books b
            JOIN Authors a ON b.AuthorID = a.AuthorID
            JOIN OrderDetails od ON b.BookID = od.BookID
            GROUP BY b.BookID, b.Title, a.Name, b.Price, b.Stock, b.Genre, b.Format, 
                     b.Language, b.PublicationDate, b.ISBN
            ORDER BY TotalSold DESC
            LIMIT 5
        `);
        res.json(result.map(book => ({
            id: book.BookID, title: book.Title, author: book.AuthorName, 
            price: parseFloat(book.Price), stock: book.Stock, sales: book.TotalSold,
            category: book.Genre, format: book.Format, language: book.Language,
            publicationDate: book.PublicationDate, rating: 4.0, reviews: 0,
            isbn: book.ISBN,
            bookCover: book.ISBN ? `https://covers.openlibrary.org/b/isbn/${book.ISBN}-M.jpg` : 
                      'https://via.placeholder.com/120x180.png?text=No+Cover'
        })));
    } catch (err) {
        console.error('Error fetching top selling books:', err);
        res.status(500).json({ error: 'Failed to fetch top selling books', details: err.message });
    }
});

app.get('/api/all-orders', async (req, res) => {
    if (!pool) return res.status(503).json({ error: 'Database not connected' });
    try {
        const [result] = await pool.query(`
            SELECT OrderID, CustomerName, OrderDate, TotalAmount, Status 
            FROM OrderSummary 
            ORDER BY OrderDate DESC, OrderID DESC
        `);
        res.json(result.map(order => ({ ...order, amount: order.TotalAmount })));
    } catch (err) {
        console.error('Error fetching all orders:', err);
        res.status(500).json({ error: 'Failed to fetch all orders', details: err.message });
    }
});

app.get('/api/low-stock-books/:threshold', async (req, res) => {
    if (!pool) return res.status(503).json({ error: 'Database not connected' });
    try {
        const threshold = parseInt(req.params.threshold) || 10;
        const [result] = await pool.query(`
            SELECT BookID, Title, Stock, ISBN 
            FROM Books 
            WHERE Stock > 0 AND Stock < ?
            ORDER BY Stock ASC
        `, [threshold]);

        const booksWithCovers = result.map(book => ({
            ...book,
            BookCover: book.ISBN ? `https://covers.openlibrary.org/b/isbn/${book.ISBN}-M.jpg` :
                      'https://via.placeholder.com/120x180.png?text=No+Cover'
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
        const [result] = await pool.query('SELECT AuthorID, Name, DOB FROM Authors ORDER BY Name');
        res.json(result);
    } catch (err) {
        console.error('Error fetching authors:', err);
        res.status(500).json({ error: 'Failed to fetch authors', details: err.message });
    }
});

app.get('/api/authors/search', async (req, res) => {
    if (!pool) return res.status(503).json({ error: 'Database not connected' });
    
    const { criteria, query } = req.query;
    if (!criteria || !query) {
        return res.status(400).json({ error: 'Search criteria and query required.' });
    }
    
    try {
        let sqlQuery = 'SELECT AuthorID, Name, DOB FROM Authors';
        let params = [];
        
        switch (criteria.toLowerCase()) {
            case 'name':
                sqlQuery += ' WHERE Name LIKE ?';
                params = [`%${query}%`];
                break;
            case 'id':
                const authorId = parseInt(query);
                if (isNaN(authorId)) return res.status(200).json([]);
                sqlQuery += ' WHERE AuthorID = ?';
                params = [authorId];
                break;
            default:
                return res.status(400).json({ error: 'Invalid search criteria. Use: name or id' });
        }
        
        sqlQuery += ' ORDER BY Name';
        const [result] = await pool.query(sqlQuery, params);
        res.status(200).json(result);
    } catch (err) {
        console.error('Error searching authors:', err);
        res.status(500).json({ error: 'Failed to search authors', details: err.message });
    }
});

app.get('/api/authors/:id', async (req, res) => {
    if (!pool) return res.status(503).json({ error: 'Database not connected' });
    try {
        const authorId = parseInt(req.params.id);
        const [result] = await pool.query('SELECT AuthorID, Name, DOB FROM Authors WHERE AuthorID = ?', [authorId]);
        if (result.length === 0) return res.status(404).json({ error: 'Author not found' });
        res.json(result[0]);
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
        await pool.query('INSERT INTO Authors (Name, DOB) VALUES (?, ?)', [name, dob || null]);
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
        
        const [result] = await pool.query('UPDATE Authors SET Name = ?, DOB = ? WHERE AuthorID = ?', 
                                         [name, dob || null, authorId]);
        if (result.affectedRows === 0) return res.status(404).json({ error: 'Author not found' });
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
        const [result] = await pool.query('DELETE FROM Authors WHERE AuthorID = ?', [authorId]);
        if (result.affectedRows === 0) return res.status(404).json({ error: 'Author not found' });
        res.json({ message: 'Author deleted successfully' });
    } catch (err) {
        console.error('Error deleting author:', err);
        if (err.code === 'ER_ROW_IS_REFERENCED_2') {
            return res.status(400).json({ error: 'Cannot delete author. It is referenced by existing books.' });
        }
        res.status(500).json({ error: 'Failed to delete author', details: err.message });
    }
});

// --- Publishers ---
app.get('/api/publishers', async (req, res) => {
    if (!pool) return res.status(503).json({ error: 'Database not connected' });
    try {
        const [result] = await pool.query('SELECT PublisherID, Name, Address, Contact FROM Publishers ORDER BY Name');
        res.json(result);
    } catch (err) {
        console.error('Error fetching publishers:', err);
        res.status(500).json({ error: 'Failed to fetch publishers', details: err.message });
    }
});

app.get('/api/publishers/search', async (req, res) => {
    if (!pool) return res.status(503).json({ error: 'Database not connected' });
    
    const { criteria, query } = req.query;
    if (!criteria || !query) {
        return res.status(400).json({ error: 'Search criteria and query required.' });
    }
    
    try {
        let sqlQuery = 'SELECT PublisherID, Name, Address, Contact FROM Publishers';
        let params = [];
        
        switch (criteria.toLowerCase()) {
            case 'name':
                sqlQuery += ' WHERE Name LIKE ?';
                params = [`%${query}%`];
                break;
            case 'id':
                const publisherId = parseInt(query);
                if (isNaN(publisherId)) return res.status(200).json([]);
                sqlQuery += ' WHERE PublisherID = ?';
                params = [publisherId];
                break;
            case 'contact':
                sqlQuery += ' WHERE Contact LIKE ?';
                params = [`%${query}%`];
                break;
            default:
                return res.status(400).json({ error: 'Invalid search criteria. Use: name, id, or contact' });
        }
        
        sqlQuery += ' ORDER BY Name';
        const [result] = await pool.query(sqlQuery, params);
        res.status(200).json(result);
    } catch (err) {
        console.error('Error searching publishers:', err);
        res.status(500).json({ error: 'Failed to search publishers', details: err.message });
    }
});

app.get('/api/publishers/:id', async (req, res) => {
    if (!pool) return res.status(503).json({ error: 'Database not connected' });
    try {
        const publisherId = parseInt(req.params.id);
        const [result] = await pool.query('SELECT PublisherID, Name, Address, Contact FROM Publishers WHERE PublisherID = ?', 
                                         [publisherId]);
        if (result.length === 0) return res.status(404).json({ error: 'Publisher not found' });
        res.json(result[0]);
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
        
        await pool.query('INSERT INTO Publishers (Name, Address, Contact) VALUES (?, ?, ?)', 
                        [name, address || null, contact || null]);
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
        
        const [result] = await pool.query(
            'UPDATE Publishers SET Name = ?, Address = ?, Contact = ? WHERE PublisherID = ?',
            [name, address || null, contact || null, publisherId]
        );
        if (result.affectedRows === 0) return res.status(404).json({ error: 'Publisher not found' });
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
        const [result] = await pool.query('DELETE FROM Publishers WHERE PublisherID = ?', [publisherId]);
        if (result.affectedRows === 0) return res.status(404).json({ error: 'Publisher not found' });
        res.json({ message: 'Publisher deleted successfully' });
    } catch (err) {
        console.error('Error deleting publisher:', err);
        if (err.code === 'ER_ROW_IS_REFERENCED_2') {
            return res.status(400).json({ error: 'Cannot delete publisher. It is referenced by existing books.' });
        }
        res.status(500).json({ error: 'Failed to delete publisher', details: err.message });
    }
});

// --- Books ---
app.get('/api/books', async (req, res) => {
    if (!pool) return res.status(503).json({ error: 'Database not connected' });
    try {
        const [result] = await pool.query(`
            SELECT b.BookID, b.Title, a.Name AS AuthorName, b.AuthorID,
                   p.Name AS PublisherName, b.PublisherID, b.Genre, b.Price, 
                   b.Stock, b.Format, b.Language, b.PublicationDate, b.ISBN
            FROM Books b
            JOIN Authors a ON b.AuthorID = a.AuthorID
            JOIN Publishers p ON b.PublisherID = p.PublisherID
            ORDER BY b.Title
        `);
        const booksWithCovers = result.map(book => ({
            ...book,
            BookCover: book.ISBN ? `https://covers.openlibrary.org/b/isbn/${book.ISBN}-M.jpg` :
                      'https://via.placeholder.com/120x180.png?text=No+Cover'
        }));
        res.json(booksWithCovers);
    } catch (err) {
        console.error('Error fetching books:', err);
        res.status(500).json({ error: 'Failed to fetch books', details: err.message });
    }
});

app.get('/api/books/search', async (req, res) => {
    if (!pool) return res.status(503).json({ error: 'Database not connected' });
    
    const { criteria, query } = req.query;
    if (!criteria || !query) {
        return res.status(400).json({ error: 'Search criteria and query are required.' });
    }
    
    try {
        let sqlQuery = `
            SELECT b.BookID, b.Title, auth.Name AS AuthorName, pub.Name AS PublisherName,
                   b.AuthorID, b.PublisherID, b.Genre, b.Price, b.Stock, b.Format,
                   b.Language, b.PublicationDate, b.ISBN
            FROM Books b
            LEFT JOIN Authors auth ON b.AuthorID = auth.AuthorID
            LEFT JOIN Publishers pub ON b.PublisherID = pub.PublisherID`;
        
        let params = [];
        
        switch (criteria.toLowerCase()) {
            case 'title':
                sqlQuery += ' WHERE b.Title LIKE ?';
                params = [`%${query}%`];
                break;
            case 'author':
                sqlQuery += ' WHERE auth.Name LIKE ?';
                params = [`%${query}%`];
                break;
            case 'genre':
                sqlQuery += ' WHERE b.Genre LIKE ?';
                params = [`%${query}%`];
                break;
            case 'id':
                const bookId = parseInt(query);
                if (isNaN(bookId)) return res.status(200).json([]);
                sqlQuery += ' WHERE b.BookID = ?';
                params = [bookId];
                break;
            default:
                return res.status(400).json({ error: 'Invalid search criteria. Use: title, author, genre, or id' });
        }
        
        sqlQuery += ' ORDER BY b.Title';
        const [result] = await pool.query(sqlQuery, params);
        
        const booksWithCovers = result.map(book => ({
            ...book,
            BookCover: book.ISBN ? `https://covers.openlibrary.org/b/isbn/${book.ISBN}-M.jpg` :
                      'https://via.placeholder.com/120x180.png?text=No+Cover'
        }));
        res.status(200).json(booksWithCovers);
    } catch (err) {
        console.error('Error searching books:', err);
        res.status(500).json({ error: 'Failed to search books', details: err.message });
    }
});

app.get('/api/books/in-stock', async (req, res) => {
    if (!pool) return res.status(503).json({ error: 'Database not connected' });
    try {
        const [result] = await pool.query('SELECT BookID, Title, Stock, Price, ISBN FROM Books WHERE Stock > 0 ORDER BY Title');
        const booksWithCovers = result.map(book => ({
            ...book,
            BookCover: book.ISBN ? `https://covers.openlibrary.org/b/isbn/${book.ISBN}-M.jpg` :
                      'https://via.placeholder.com/120x180.png?text=No+Cover'
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
        const [result] = await pool.query(`
            SELECT b.BookID, b.Title, b.AuthorID, auth.Name as AuthorName,
                   b.PublisherID, pub.Name as PublisherName, b.Genre, b.Price,
                   b.Stock, b.Format, b.Language, b.PublicationDate, b.ISBN
            FROM Books b
            LEFT JOIN Authors auth ON b.AuthorID = auth.AuthorID
            LEFT JOIN Publishers pub ON b.PublisherID = pub.PublisherID
            WHERE b.BookID = ?
        `, [bookId]);
        
        if (result.length === 0) return res.status(404).json({ error: 'Book not found' });
        
        const book = result[0];
        const bookWithCover = {
            ...book,
            BookCover: book.ISBN ? `https://covers.openlibrary.org/b/isbn/${book.ISBN}-M.jpg` :
                      'https://via.placeholder.com/120x180.png?text=No+Cover'
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
        const { title, authorId, publisherId, genre, price, stock, format, language, publicationDate, isbn } = req.body;
        if (!title || authorId == null || publisherId == null || price == null || stock == null || !format || !publicationDate) {
            return res.status(400).json({ error: 'Missing required book fields.' });
        }
        
        await pool.query(
            'CALL InsertBook(?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
            [title, parseInt(authorId), parseInt(publisherId), genre || null, parseFloat(price), 
             parseInt(stock), format, language || null, publicationDate, isbn || null]
        );
        res.status(201).json({ message: 'Book added successfully' });
    } catch (err) {
        console.error('Error adding book:', err);
        if (err.code === 'ER_DUP_ENTRY') {
            res.status(400).json({ error: 'Book with this title already exists.' });
        } else {
            res.status(500).json({ error: 'Failed to add book.', details: err.message });
        }
    }
});

app.put('/api/books/:id', async (req, res) => {
    if (!pool) return res.status(503).json({ error: 'Database not connected' });
    try {
        const bookId = parseInt(req.params.id);
        const { title, authorId, publisherId, genre, price, stock, format, language, publicationDate, isbn } = req.body;
        if (!title || authorId == null || publisherId == null || price == null || stock == null || !format || !publicationDate) {
            return res.status(400).json({ error: 'Missing required fields for update.' });
        }
        
        const [result] = await pool.query(`
            UPDATE Books SET Title = ?, AuthorID = ?, PublisherID = ?, Genre = ?,
                   Price = ?, Stock = ?, Format = ?, Language = ?,
                   PublicationDate = ?, ISBN = ?
            WHERE BookID = ?
        `, [title, parseInt(authorId), parseInt(publisherId), genre || null, parseFloat(price),
            parseInt(stock), format, language || null, publicationDate, isbn || null, bookId]);
            
        if (result.affectedRows === 0) return res.status(404).json({ error: 'Book not found or no changes made.' });
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
        
        const [result] = await pool.query('DELETE FROM Books WHERE BookID = ?', [bookId]);
        if (result.affectedRows === 0) return res.status(404).json({ error: 'Book not found.' });
        res.json({ message: 'Book deleted successfully' });
    } catch (err) {
        console.error('Error deleting book:', err);
        if (err.code === 'ER_ROW_IS_REFERENCED_2') {
            return res.status(400).json({ error: 'Cannot delete book. It is referenced in existing records.' });
        }
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
        
        await pool.query('CALL UpdateBookStock(?, ?)', [bookId, parseInt(stockChange)]);
        const [stockResult] = await pool.query('SELECT Stock FROM Books WHERE BookID = ?', [bookId]);
        if (stockResult.length === 0) return res.status(404).json({ error: 'Book not found' });
        res.json({ message: 'Stock updated successfully', newStock: stockResult[0].Stock });
    } catch (err) {
        console.error('Error updating book stock:', err);
        res.status(500).json({ error: 'Failed to update stock', details: err.message });
    }
});

// --- Customers ---
app.get('/api/customers', async (req, res) => {
    if (!pool) return res.status(503).json({ error: 'Database not connected' });
    try {
        const [result] = await pool.query(`
            SELECT c.CustomerID, c.FirstName, c.LastName, c.Email, c.Phone, 
                   c.ShippingAddress, c.BillingAddress,
                   (SELECT COUNT(o.OrderID) FROM Orders o WHERE o.CustomerID = c.CustomerID) AS TotalOrders
            FROM Customers c 
            ORDER BY c.LastName, c.FirstName
        `);
        res.json(result);
    } catch (err) {
        console.error('Error fetching customers:', err);
        res.status(500).json({ error: 'Failed to fetch customers', details: err.message });
    }
});

app.get('/api/customers/search', async (req, res) => {
    if (!pool) return res.status(503).json({ error: 'Database not connected' });
    
    const { criteria, query } = req.query;
    if (!criteria || !query) {
        return res.status(400).json({ error: 'Search criteria and query are required.' });
    }
    
    try {
        let sqlQuery = `
            SELECT c.CustomerID, c.FirstName, c.LastName, c.Email, c.Phone,
                   (SELECT COUNT(o.OrderID) FROM Orders o WHERE o.CustomerID = c.CustomerID) AS TotalOrders
            FROM Customers c`;
        let params = [];
        
        switch (criteria.toLowerCase()) {
            case 'name':
                sqlQuery += ` WHERE (c.FirstName LIKE ? OR c.LastName LIKE ? OR CONCAT(c.FirstName, ' ', c.LastName) LIKE ?)`;
                params = [`%${query}%`, `%${query}%`, `%${query}%`];
                break;
            case 'email':
                sqlQuery += ' WHERE c.Email LIKE ?';
                params = [`%${query}%`];
                break;
            case 'id':
                const customerId = parseInt(query);
                if (isNaN(customerId)) return res.status(200).json([]);
                sqlQuery += ' WHERE c.CustomerID = ?';
                params = [customerId];
                break;
            default:
                return res.status(400).json({ error: 'Invalid search criteria. Use: name, email, or id' });
        }
        
        sqlQuery += ' ORDER BY c.LastName, c.FirstName';
        const [result] = await pool.query(sqlQuery, params);
        res.status(200).json(result);
    } catch (err) {
        console.error('Error searching customers:', err);
        res.status(500).json({ error: 'Failed to search customers', details: err.message });
    }
});

app.get('/api/customers/:id', async (req, res) => {
    if (!pool) return res.status(503).json({ error: 'Database not connected' });
    try {
        const customerId = parseInt(req.params.id);
        const [result] = await pool.query('SELECT * FROM Customers WHERE CustomerID = ?', [customerId]);
        if (result.length === 0) return res.status(404).json({ error: 'Customer not found' });
        res.json(result[0]);
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
        
        await pool.query(
            'CALL AddCustomer(?, ?, ?, ?, ?, ?, ?)',
            [firstName, lastName, email, phone || null, password || null, 
             shippingAddress || null, billingAddress || null]
        );
        res.status(201).json({ message: 'Customer added successfully' });
    } catch (err) {
        console.error('Error adding customer:', err);
        if (err.code === 'ER_DUP_ENTRY') {
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
        if (!firstName || !lastName || !email) {
            return res.status(400).json({ error: 'First name, last name, email required' });
        }

        let query = `UPDATE Customers SET FirstName = ?, LastName = ?, Email = ?, Phone = ?, 
                     ShippingAddress = ?, BillingAddress = ?`;
        let params = [firstName, lastName, email, phone || null, shippingAddress || null, billingAddress || null];
        
        if (password) {
            query += `, Password = ?`;
            params.push(password);
        }
        query += ` WHERE CustomerID = ?`;
        params.push(customerId);
        
        const [result] = await pool.query(query, params);
        if (result.affectedRows === 0) return res.status(404).json({ error: 'Customer not found' });
        res.json({ message: 'Customer updated successfully' });
    } catch (err) {
        console.error('Error updating customer:', err);
        if (err.code === 'ER_DUP_ENTRY') {
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
        const [ordersCheck] = await pool.query('SELECT COUNT(*) as OrderCount FROM Orders WHERE CustomerID = ?', 
                                               [customerId]);
        if (ordersCheck[0].OrderCount > 0) {
            return res.status(400).json({ error: 'Cannot delete customer with existing orders. Consider deactivating instead.' });
        }
        
        const [result] = await pool.query('DELETE FROM Customers WHERE CustomerID = ?', [customerId]);
        if (result.affectedRows === 0) return res.status(404).json({ error: 'Customer not found' });
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
        
        const [result] = await pool.query(
            'SELECT * FROM CustomerOrders WHERE CustomerID = ? ORDER BY OrderDate DESC',
            [customerId]
        );
        res.json(result);
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
        
        for (const item of items) {
            await pool.query('CALL PlaceOrder(?, ?, ?, ?)', 
                           [parseInt(customerId), parseInt(item.bookId), parseInt(item.quantity), paymentMethod]);
        }
        
        res.status(201).json({ message: 'Order placed successfully' });
    } catch (err) {
        console.error('Error placing order:', err);
        if (err.message.includes('insufficient stock') || err.code === 'ER_ROW_IS_REFERENCED_2') {
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
        
        const [result] = await pool.query(`
            SELECT od.OrderDetailID, od.OrderID, od.BookID, b.Title, a.Name AS AuthorName, 
                   od.Quantity, b.Price, (od.Quantity * b.Price) AS LineTotal
            FROM OrderDetails od 
            JOIN Books b ON od.BookID = b.BookID 
            JOIN Authors a ON b.AuthorID = a.AuthorID
            WHERE od.OrderID = ?
        `, [orderId]);
        
        res.json(result);
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
        if (isNaN(orderId) || !status) {
            return res.status(400).json({ error: 'Valid order ID and status are required' });
        }
        
        await pool.query('UPDATE Orders SET Status = ? WHERE OrderID = ?', [status, orderId]);
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
        const [result] = await pool.query(`
            SELECT DISTINCT Genre AS Name, 
                   (@row_number:=@row_number + 1) AS GenreID 
            FROM Books, (SELECT @row_number:=0) AS t
            WHERE Genre IS NOT NULL AND Genre != ''
            ORDER BY Genre
        `);
        res.json(result);
    } catch (err) {
        console.error('Error fetching genres:', err);
        res.status(500).json({ error: 'Failed to fetch genres', details: err.message });
    }
});

app.get('/api/genres/search', async (req, res) => {
    if (!pool) return res.status(503).json({ error: 'Database not connected' });
    
    const { name } = req.query;
    if (!name) {
        return res.status(400).json({ error: 'Genre name for search is required.' });
    }
    
    try {
        const [result] = await pool.query(`
            SELECT DISTINCT Genre AS Name,
                   (@row_number:=@row_number + 1) AS GenreID
            FROM Books, (SELECT @row_number:=0) AS t
            WHERE Genre LIKE ?
            ORDER BY Genre
        `, [`%${name}%`]);
        
        res.status(200).json(result);
    } catch (err) {
        console.error('Error searching genres:', err);
        res.status(500).json({ error: 'Failed to search genres', details: err.message });
    }
});

// --- NOTIFICATIONS ---
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
            const emptyNotifications = { unread: [], read: [] };
            await writeNotificationsFile(emptyNotifications);
            return emptyNotifications;
        }
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
    try {
        const notifications = await readNotificationsFile();
        notifications.unread.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));
        notifications.read.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));
        res.json(notifications);
    } catch (error) {
        res.status(500).json({ error: 'Failed to fetch notifications', details: error.message });
    }
});

app.post('/api/notifications', async (req, res) => {
    try {
        const newNotification = req.body;
        if (!newNotification.id || !newNotification.headline || !newNotification.message || !newNotification.timestamp) {
            return res.status(400).json({ error: 'Missing required notification fields.' });
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
        res.status(500).json({ error: 'Failed to add notification', details: error.message });
    }
});

app.put('/api/notifications/:id/status', async (req, res) => {
    try {
        const notificationId = req.params.id;
        const { read } = req.body;

        if (typeof read !== 'boolean') {
            return res.status(400).json({ error: 'Invalid "read" status provided.' });
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
        res.status(500).json({ error: 'Failed to update notification status', details: error.message });
    }
});

app.put('/api/notifications/mark-all-read', async (req, res) => {
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
        res.status(500).json({ error: 'Failed to mark all as read', details: error.message });
    }
});

app.delete('/api/notifications/:id', async (req, res) => {
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
        res.status(500).json({ error: 'Failed to delete notification', details: error.message });
    }
});
// --- LOGIN ROUTE ---
app.post('/api/admin/login', async (req, res) => {
    if (!pool) return res.status(503).json({ error: 'Database not connected' });
   
    const { email, password } = req.body;

    if (!email || !password) {
        return res.status(400).json({ error: 'Email and password are required' });
    }

    try {
        
        const [adminRows] = await pool.query(
            'SELECT * FROM Admins WHERE Email = ? AND AdminPass = ?', 
            [email, password]
        );

        if (adminRows.length > 0) {

            return res.json({ 
                success: true, 
                role: 'admin', 
                user: adminRows[0],
                message: 'Admin login successful'
            });
        }

        const [customerRows] = await pool.query(
            'SELECT * FROM Customers WHERE Email = ? AND Password = ?', 
            [email, password]
        );

        if (customerRows.length > 0) {
            return res.json({ 
                success: true, 
                role: 'customer', 
                user: customerRows[0],
                message: 'Customer login successful'
            });
        }

        return res.status(401).json({ error: 'Invalid email or password' });

    } catch (err) {
        console.error('Login error:', err);
        res.status(500).json({ error: 'Login failed', details: err.message });
    }
});

// --- Server Setup ---
connectDb().then(() => {
    app.listen(port, () => {
        console.log(`Server is running on http://localhost:${port}`);
    });
});
