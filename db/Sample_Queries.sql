-- =====================================================
-- BOOKSTORE DATABASE - MySQL Version
-- Converted from SQL Server to MySQL
-- =====================================================

-- Drop database if exists and create new one
DROP DATABASE IF EXISTS BookStore;
CREATE DATABASE BookStore;
USE BookStore;

-- =====================================================
-- TABLES
-- =====================================================

-- Authors Table
CREATE TABLE Authors (
    AuthorID INT AUTO_INCREMENT PRIMARY KEY,
    Name VARCHAR(100) NOT NULL,
    DOB DATE
);

-- Publishers Table
CREATE TABLE Publishers (
    PublisherID INT AUTO_INCREMENT PRIMARY KEY,
    Name VARCHAR(100) NOT NULL,
    Address VARCHAR(255),
    Contact VARCHAR(100)
);

-- Books Table
CREATE TABLE Books (
    BookID INT AUTO_INCREMENT PRIMARY KEY,
    Title VARCHAR(200) NOT NULL UNIQUE,
    AuthorID INT NOT NULL,
    PublisherID INT NOT NULL,
    Genre VARCHAR(100),
    Price DECIMAL(10, 2) CHECK (Price >= 0),
    Stock INT CHECK (Stock >= 0),
    Format VARCHAR(50) CHECK (Format IN ('eBook', 'Hardcover', 'Paperback')),
    Language VARCHAR(50),
    PublicationDate DATE,
    ISBN VARCHAR(17),
    FOREIGN KEY (AuthorID) REFERENCES Authors(AuthorID),
    FOREIGN KEY (PublisherID) REFERENCES Publishers(PublisherID),
    INDEX IX_Books_ISBN (ISBN)
);

-- Customers Table
CREATE TABLE Customers (
    CustomerID INT AUTO_INCREMENT PRIMARY KEY,
    FirstName VARCHAR(100) NOT NULL,
    LastName VARCHAR(100) NOT NULL,
    Email VARCHAR(100) NOT NULL UNIQUE,
    Phone VARCHAR(20),
    Password VARCHAR(255),
    ShippingAddress VARCHAR(255),
    BillingAddress VARCHAR(255)
);

-- Orders Table
CREATE TABLE Orders (
    OrderID INT AUTO_INCREMENT PRIMARY KEY,
    CustomerID INT NOT NULL,
    OrderDate DATE DEFAULT (CURRENT_DATE),
    Status VARCHAR(50) DEFAULT 'Pending',
    FOREIGN KEY (CustomerID) REFERENCES Customers(CustomerID)
);

-- OrderDetails Table
CREATE TABLE OrderDetails (
    OrderDetailID INT AUTO_INCREMENT PRIMARY KEY,
    OrderID INT NOT NULL,
    BookID INT NOT NULL,
    Quantity INT CHECK (Quantity > 0),
    FOREIGN KEY (OrderID) REFERENCES Orders(OrderID),
    FOREIGN KEY (BookID) REFERENCES Books(BookID)
);

-- Payments Table
CREATE TABLE Payments (
    PaymentID INT AUTO_INCREMENT PRIMARY KEY,
    OrderID INT NOT NULL,
    PaymentMethod VARCHAR(50) CHECK (PaymentMethod IN ('SadaPay', 'EasyPaisa', 'JazzCash', 'Card', 'Cash')),
    PaymentDate DATETIME DEFAULT CURRENT_TIMESTAMP,
    Amount DECIMAL(10, 2) CHECK (Amount >= 0),
    FOREIGN KEY (OrderID) REFERENCES Orders(OrderID)
);

-- Admins Table
CREATE TABLE Admins (
    AdminID INT AUTO_INCREMENT PRIMARY KEY,
    Email VARCHAR(100) NOT NULL UNIQUE,
    AdminPass VARCHAR(255) NOT NULL,
    FirstName VARCHAR(50),
    LastName VARCHAR(50),
    IsActive BOOLEAN DEFAULT TRUE,
    CreatedDate DATETIME DEFAULT CURRENT_TIMESTAMP,
    LastLoginDate DATETIME,
    UpdatedDate DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    INDEX IX_Admins_Email (Email)
);

-- OrderLog Table
CREATE TABLE OrderLog (
    LogID INT AUTO_INCREMENT PRIMARY KEY,
    OrderID INT,
    LogDate DATETIME DEFAULT CURRENT_TIMESTAMP,
    PaymentMethod VARCHAR(50),
    FOREIGN KEY (OrderID) REFERENCES Orders(OrderID)
);

-- =====================================================
-- VIEWS
-- =====================================================

-- 1. BookDetails: Full book info with author and publisher
CREATE VIEW BookDetails AS
SELECT 
    b.BookID, b.Title, a.Name AS AuthorName, p.Name AS PublisherName,
    b.Genre, b.Price, b.Stock, b.Format, b.Language, b.PublicationDate
FROM Books b
JOIN Authors a ON b.AuthorID = a.AuthorID
JOIN Publishers p ON b.PublisherID = p.PublisherID;

-- 2. OrderSummary: Orders with customer and total price
CREATE VIEW OrderSummary AS
SELECT 
    o.OrderID, 
    CONCAT(c.FirstName, ' ', c.LastName) AS CustomerName, 
    o.OrderDate,
    SUM(b.Price * od.Quantity) AS TotalAmount,
    o.Status
FROM Orders o
JOIN Customers c ON o.CustomerID = c.CustomerID
JOIN OrderDetails od ON o.OrderID = od.OrderID
JOIN Books b ON od.BookID = b.BookID
GROUP BY o.OrderID, c.FirstName, c.LastName, o.OrderDate, o.Status;

-- 3. TopSellingBooks: Top 5 best-selling books by quantity
CREATE VIEW TopSellingBooks AS
SELECT 
    b.Title, SUM(od.Quantity) AS TotalSold
FROM OrderDetails od
JOIN Books b ON od.BookID = b.BookID
GROUP BY b.Title
ORDER BY TotalSold DESC
LIMIT 5;

-- 4. CustomerOrders: List orders and payments per customer
CREATE VIEW CustomerOrders AS
SELECT
    c.CustomerID,
    c.FirstName,
    c.LastName,
    o.OrderID,
    o.OrderDate,
    p.PaymentMethod,
    p.Amount
FROM Customers c
LEFT JOIN Orders o ON c.CustomerID = o.CustomerID
LEFT JOIN Payments p ON o.OrderID = p.OrderID;

-- 5. BooksInStock: Books where stock > 0
CREATE VIEW BooksInStock AS
SELECT BookID, Title, Stock
FROM Books
WHERE Stock > 0;

-- =====================================================
-- STORED PROCEDURES
-- =====================================================

-- 1. InsertBook
DELIMITER //
CREATE PROCEDURE InsertBook(
    IN p_Title VARCHAR(200),
    IN p_AuthorID INT,
    IN p_PublisherID INT,
    IN p_Genre VARCHAR(100),
    IN p_Price DECIMAL(10,2),
    IN p_Stock INT,
    IN p_Format VARCHAR(50),
    IN p_Language VARCHAR(50),
    IN p_PublicationDate DATE,
    IN p_ISBN VARCHAR(17)
)
BEGIN
    INSERT INTO Books (Title, AuthorID, PublisherID, Genre, Price, Stock, Format, Language, PublicationDate, ISBN)
    VALUES (p_Title, p_AuthorID, p_PublisherID, p_Genre, p_Price, p_Stock, p_Format, p_Language, p_PublicationDate, p_ISBN);
END //
DELIMITER ;

-- 2. AddCustomer
DELIMITER //
CREATE PROCEDURE AddCustomer(
    IN p_FirstName VARCHAR(100),
    IN p_LastName VARCHAR(100),
    IN p_Email VARCHAR(100),
    IN p_Phone VARCHAR(20),
    IN p_Password VARCHAR(255),
    IN p_ShippingAddress VARCHAR(255),
    IN p_BillingAddress VARCHAR(255)
)
BEGIN
    INSERT INTO Customers (FirstName, LastName, Email, Phone, Password, ShippingAddress, BillingAddress)
    VALUES (p_FirstName, p_LastName, p_Email, p_Phone, p_Password, p_ShippingAddress, p_BillingAddress);
END //
DELIMITER ;

-- 3. UpdateBookStock
DELIMITER //
CREATE PROCEDURE UpdateBookStock(
    IN p_BookID INT,
    IN p_StockChange INT
)
BEGIN
    UPDATE Books
    SET Stock = Stock + p_StockChange
    WHERE BookID = p_BookID AND Stock + p_StockChange >= 0;
END //
DELIMITER ;

-- 4. PlaceOrder (Simplified for MySQL)
DELIMITER //
CREATE PROCEDURE PlaceOrder(
    IN p_CustomerID INT,
    IN p_BookID INT,
    IN p_Quantity INT,
    IN p_PaymentMethod VARCHAR(50)
)
BEGIN
    DECLARE v_OrderID INT;
    DECLARE v_TotalAmount DECIMAL(10,2);
    DECLARE v_BookPrice DECIMAL(10,2);
    
    -- Start transaction
    START TRANSACTION;
    
    -- Create new order
    INSERT INTO Orders (CustomerID) VALUES (p_CustomerID);
    SET v_OrderID = LAST_INSERT_ID();
    
    -- Insert order details
    INSERT INTO OrderDetails (OrderID, BookID, Quantity)
    VALUES (v_OrderID, p_BookID, p_Quantity);
    
    -- Update book stock
    UPDATE Books
    SET Stock = Stock - p_Quantity
    WHERE BookID = p_BookID AND Stock >= p_Quantity;
    
    -- Calculate total amount
    SELECT Price INTO v_BookPrice FROM Books WHERE BookID = p_BookID;
    SET v_TotalAmount = v_BookPrice * p_Quantity;
    
    -- Record payment
    INSERT INTO Payments (OrderID, PaymentMethod, Amount)
    VALUES (v_OrderID, p_PaymentMethod, v_TotalAmount);
    
    -- Log the order
    INSERT INTO OrderLog (OrderID, PaymentMethod)
    VALUES (v_OrderID, p_PaymentMethod);
    
    COMMIT;
    
    SELECT v_OrderID AS OrderID, v_TotalAmount AS TotalAmount;
END //
DELIMITER ;

-- =====================================================
-- SAMPLE DATA (Optional - uncomment to insert)
-- =====================================================

/*
-- Insert sample authors
INSERT INTO Authors (Name, DOB) VALUES 
('J.K. Rowling', '1965-07-31'),
('George R.R. Martin', '1948-09-20'),
('Stephen King', '1947-09-21');

-- Insert sample publishers
INSERT INTO Publishers (Name, Address, Contact) VALUES 
('Bloomsbury', 'London, UK', 'contact@bloomsbury.com'),
('Bantam Books', 'New York, USA', 'info@bantam.com'),
('Scribner', 'New York, USA', 'contact@scribner.com');

-- Insert sample books
INSERT INTO Books (Title, AuthorID, PublisherID, Genre, Price, Stock, Format, Language, PublicationDate, ISBN) VALUES 
('Harry Potter and the Philosopher''s Stone', 1, 1, 'Fantasy', 299.99, 50, 'Paperback', 'English', '1997-06-26', '978-0-7475-3269-9'),
('A Game of Thrones', 2, 2, 'Fantasy', 599.99, 30, 'Hardcover', 'English', '1996-08-06', '978-0-553-10354-0'),
('The Shining', 3, 3, 'Horror', 399.99, 25, 'Paperback', 'English', '1977-01-28', '978-0-385-12167-5');
*/
INSERT INTO Authors (Name, DOB) VALUES 
('J.K. Rowling', '1965-07-31'),
('Saadat Hasan Manto', '1912-05-11'),
('Stephen King', '1947-09-21'),
('Paulo Coelho', '1947-08-24');

INSERT INTO Publishers (Name, Address, Contact) VALUES 
('Bloomsbury', 'London, UK', 'contact@bloomsbury.com'),
('Sang-e-Meel Publications', 'Lahore, Pakistan', 'info@sangemeel.com'),
('HarperCollins', 'New York, USA', 'help@harpercollins.com');

INSERT INTO Books (Title, AuthorID, PublisherID, Genre, Price, Stock, Format, Language, PublicationDate, ISBN) VALUES 

('Mottled Dawn', 2, 2, 'History', 1200.00, 30, 'Hardcover', 'Urdu', '2011-01-01', '978-0195476314'),

('The Alchemist', 4, 3, 'Fiction', 900.00, 100, 'Paperback', 'English', '1988-01-01', '978-0062315007');

INSERT INTO Customers (FirstName, LastName, Email, Phone, Password, ShippingAddress, BillingAddress) VALUES 
('Ali', 'Khan', 'ali.khan@example.com', '03001234567', 'hashed_pass_1', 'House 12, Street 4, DHA Lahore', 'House 12, Street 4, DHA Lahore'),
('Sara', 'Ahmed', 'sara.ahmed@example.com', '03219876543', 'hashed_pass_2', 'Flat 4B, Clifton, Karachi', 'Flat 4B, Clifton, Karachi'),
('Bilal', 'Sheikh', 'bilal.s@example.com', '03335555555', 'hashed_pass_3', 'Sector F-7, Islamabad', 'Sector F-7, Islamabad');

INSERT INTO Orders (CustomerID, OrderDate, Status) VALUES 
(1, '2023-10-01', 'Completed'),
(2, '2023-10-05', 'Pending'),
(3, '2023-10-06', 'Completed');

INSERT INTO OrderDetails (OrderID, BookID, Quantity) VALUES 
(1, 1, 1), 
(2, 2, 2),
(3, 4, 1);

INSERT INTO Payments (OrderID, PaymentMethod, Amount) VALUES 
(1, 'Card', 2500.00),
(2, 'JazzCash', 2400.00),
(3, 'SadaPay', 900.00);

INSERT INTO Admins (Email, AdminPass, FirstName, LastName) VALUES 
('admin@bookstore.com', 'admin_secure_pass', 'System', 'Admin'),
('manager@bookstore.com', 'manager_pass', 'Store', 'Manager');

INSERT INTO OrderLog (OrderID, PaymentMethod) VALUES 
(1, 'Card'),
(2, 'JazzCash'),
(3, 'SadaPay');
