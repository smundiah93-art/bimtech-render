const express = require('express');
const { Pool } = require('pg');
const dotenv = require('dotenv');
const bcrypt = require('bcrypt');
const helmet = require('helmet');
const morgan = require('morgan');
const compression = require('compression');
const rateLimit = require('express-rate-limit');
const path = require('path');
const net = require('net');
const fs = require('fs');

// Load environment variables from .env file
const envPath = path.join(__dirname, '..', '.env');
if (!fs.existsSync(envPath)) {
  console.error(`.env file not found at ${envPath}.`);
  console.error('Create a .env file with the following format:');
  console.error('PORT=53572');
  console.error('ADMIN_PASSWORD=your_secure_admin_password');
  console.error('DATABASE_URL=postgres://postgres:your_password@localhost:5432/your_database');
  process.exit(1);
}

try {
  const envContent = fs.readFileSync(envPath, 'utf8').trim();
  if (!envContent) {
    console.error(`.env file at ${envPath} is empty.`);
    console.error('Add the following to your .env file:');
    console.error('PORT=53572');
    console.error('ADMIN_PASSWORD=your_secure_admin_password');
    console.error('DATABASE_URL=postgres://postgres:your_password@localhost:5432/your_database');
    process.exit(1);
  }
  console.log('.env file content (raw):', envContent.replace(/=.*/g, '=[hidden]')); // Log redacted content
} catch (err) {
  console.error(`Failed to read .env file at ${envPath}:`, err.message);
  process.exit(1);
}

const envConfig = dotenv.config({ path: envPath, override: true });
if (envConfig.error) {
  console.error('Error parsing .env file:', envConfig.error.message);
  console.error('Ensure the .env file has valid key-value pairs (e.g., KEY=VALUE) with no trailing spaces.');
  process.exit(1);
}
if (!envConfig.parsed || Object.keys(envConfig.parsed).length === 0) {
  console.error('No environment variables loaded from .env. Ensure the file contains valid key-value pairs.');
  process.exit(1);
}

// Log DATABASE_URL for debugging
console.log('DATABASE_URL:', process.env.DATABASE_URL);

// Validate environment variables
const PORT = parseInt(process.env.PORT, 10) || 53572;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'secureAdminPassword123!';
const DATABASE_URL = process.env.DATABASE_URL;
if (!PORT || !ADMIN_PASSWORD || !DATABASE_URL) {
  console.error('Missing required environment variables: PORT, ADMIN_PASSWORD, or DATABASE_URL');
  console.error('Check your .env file at', envPath);
  process.exit(1);
}

// Log environment variables for debugging (hide sensitive data)
console.log('Environment variables:', {
  PORT,
  ADMIN_PASSWORD: '[hidden]',
  DATABASE_URL: '[set]',
});

// Validate DATABASE_URL format
const urlPattern = /^postgres:\/\/[^:]+:[^@]+@[^:]+:\d+\/.+$/;
if (!urlPattern.test(DATABASE_URL)) {
  console.error('Invalid DATABASE_URL format. Expected: postgres://user:password@host:port/dbname');
  console.error('Current DATABASE_URL:', DATABASE_URL.replace(/:[^@]+@/, ':****@'));
  process.exit(1);
}

// Initialize Express app
const app = express();
app.use(express.json());
app.use(express.static('public')); // Serve static files including favicon.ico
app.use(helmet()); // Security headers
app.use(morgan('combined')); // HTTP request logging
app.use(compression()); // Compress responses
app.use(rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 100, // Limit each IP to 100 requests per window
}));

// Initialize PostgreSQL pool
const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: DATABASE_URL.includes('localhost') ? false : { rejectUnauthorized: false },
  max: 20,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 2000,
});

let dbInitialized = false;

// Test database connection manually
async function testDbConnection() {
  try {
    const client = await pool.connect();
    console.log('Manual connection test successful');
    client.release();
    return true;
  } catch (err) {
    console.error('Manual connection test failed:', {
      message: err.message,
      code: err.code,
      stack: err.stack,
      hint: 'Ensure PostgreSQL is installed and running. Install PostgreSQL or add its bin directory (e.g., C:\\Program Files\\PostgreSQL\\<version>\\bin) to your PATH. Then test with: psql -U postgres -h localhost -p 5432 -d your_database',
    });
    return false;
  }
}

// Retry database connection up to 3 times
async function connectWithRetry(maxRetries = 3, retryDelay = 2000) {
  try {
    const url = new URL(DATABASE_URL);
    console.log('DATABASE_URL components:', {
      user: url.username,
      host: url.hostname,
      port: url.port,
      database: url.pathname.slice(1),
      password: '[hidden]',
    });
  } catch (err) {
    console.error('Failed to parse DATABASE_URL:', err.message);
    process.exit(1);
  }

  const connected = await testDbConnection();
  if (!connected) {
    console.error('Initial connection test failed. Please verify PostgreSQL installation and credentials.');
    process.exit(1);
  }

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      const client = await pool.connect();
      console.log(`Connected to PostgreSQL database on attempt ${attempt}`);
      const dbName = DATABASE_URL.split('/').pop().split('?')[0];
      const dbExists = await client.query(`SELECT 1 FROM pg_database WHERE datname = $1`, [dbName]);
      if (dbExists.rowCount === 0) {
        console.error(`Database ${dbName} does not exist. Create it with: createdb -U postgres -h localhost ${dbName}`);
        console.error('If createdb is not recognized, ensure PostgreSQL bin directory is in PATH or install PostgreSQL.');
        client.release();
        process.exit(1);
      }
      client.release();
      await initializeDatabase();
      dbInitialized = true;
      setTimeout(setupDatabase, 1000);
      await startServer(); // Start server only after successful DB connection
      break;
    } catch (err) {
      console.error(`Attempt ${attempt} to connect to PostgreSQL failed:`, {
        message: err.message,
        code: err.code,
        stack: err.stack,
        hint: 'Verify the password in DATABASE_URL, ensure PostgreSQL is running, and check pg_hba.conf settings.',
      });
      if (attempt === maxRetries) {
        console.error(`All ${maxRetries} connection attempts failed. Exiting...`);
        process.exit(1);
      }
      await new Promise(resolve => setTimeout(resolve, retryDelay));
    }
  }
}

// Create tables
async function initializeDatabase() {
  try {
    await pool.query(`
        CREATE TABLE IF NOT EXISTS Users (
                                             id SERIAL PRIMARY KEY,
                                             username TEXT NOT NULL UNIQUE,
                                             password TEXT NOT NULL
        )
    `);
    console.log('Users table created or already exists');

    await pool.query(`
        CREATE TABLE IF NOT EXISTS Products (
                                                id SERIAL PRIMARY KEY,
                                                name TEXT NOT NULL
        )
    `);
    console.log('Products table created or already exists');

    await pool.query(`
        CREATE TABLE IF NOT EXISTS Transactions (
                                                    id SERIAL PRIMARY KEY,
                                                    productId INTEGER,
                                                    userId INTEGER,
                                                    date TEXT NOT NULL,
                                                    FOREIGN KEY (productId) REFERENCES Products(id),
            FOREIGN KEY (userId) REFERENCES Users(id)
            )
    `);
    console.log('Transactions table created or already exists');
  } catch (err) {
    console.error('Error initializing database:', {
      message: err.message,
      code: err.code,
      detail: err.detail,
      stack: err.stack,
    });
    throw err;
  }
}

// Setup default admin user and clean up data
async function setupDatabase() {
  try {
    await pool.query(`DELETE FROM Users WHERE username = 'admin'`);
    console.log('Old admin user removed');

    const hashedPassword = await bcrypt.hash(ADMIN_PASSWORD, 10);
    await pool.query(
      `INSERT INTO Users (username, password) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
      ['admin', hashedPassword]
    );
    console.log('Default admin user inserted');

    const res = await pool.query('SELECT * FROM Users WHERE username = $1', ['admin']);
    console.log('Admin user data:', res.rows);

    const allUsers = await pool.query(`SELECT id, username FROM Users`);
    const users = allUsers.rows.map(row => ({ id: row.id, username: row.username, password: '[hidden]' }));
    console.log('Users:', users);
  } catch (err) {
    console.error('Error setting up database:', {
      message: err.message,
      code: err.code,
      detail: err.detail,
      stack: err.stack,
    });
    throw err;
  }
}

// Check if port is in use and find an available one
async function findAvailablePort(startPort, host) {
  return new Promise((resolve, reject) => {
    let port = startPort;
    const maxPort = startPort + 10; // Limit to 10 ports
    function checkNext() {
      const server = net.createServer();
      server.once('error', (err) => {
        if (err.code === 'EADDRINUSE') {
          console.warn(`Port ${port} is in use. Checking next port...`);
          port++;
          if (port > maxPort) {
            reject(new Error(`No available ports in range ${startPort}-${maxPort}`));
          } else {
            checkNext();
          }
        } else {
          reject(err);
        }
      });
      server.once('listening', () => {
        server.close();
        resolve(port);
      });
      server.listen(port, host);
    }
    checkNext();
  });
}

// Start server with port check
async function startServer() {
  try {
    const availablePort = await findAvailablePort(PORT, '0.0.0.0'); // Bind to 0.0.0.0 for Render
    if (availablePort !== PORT) {
      console.warn(`Port ${PORT} overridden by Render. Using ${availablePort} instead.`);
    }
    const server = app.listen(availablePort, '0.0.0.0', () => {
      console.log(`Server running at http://0.0.0.0:${availablePort}`);
    });

    // Basic route
    app.get('/', (req, res) => {
      res.set('Cache-Control', 'public, max-age=300');
      res.send('Server is running!');
    });

    // Health check endpoint
    app.get('/health', async (req, res) => {
      try {
        await pool.query('SELECT NOW()');
        res.status(200).json({ status: 'ok', database: 'connected' });
      } catch (err) {
        res.status(500).json({ status: 'error', database: 'disconnected', error: err.message });
      }
    });

    // Graceful shutdown
    process.on('SIGTERM', () => {
      console.log('Received SIGTERM. Shutting down gracefully...');
      server.close(() => {
        if (dbInitialized) {
          pool.end((err) => {
            if (err) console.error('Error closing database pool:', err.message);
            console.log('Database pool closed');
          });
        }
        process.exit(0);
      });
    });

    process.on('SIGINT', () => {
      console.log('Received SIGINT. Shutting down gracefully...');
      server.close(() => {
        if (dbInitialized) {
          pool.end((err) => {
            if (err) console.error('Error closing database pool:', err.message);
            console.log('Database pool closed');
          });
        }
        process.exit(0);
      });
    });
  } catch (err) {
    console.error('Failed to start server:', err.message);
    process.exit(1);
  }
}

// Start the database connection process
connectWithRetry();