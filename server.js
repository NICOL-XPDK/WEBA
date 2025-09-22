const express = require('express');
const { BlobServiceClient } = require('@azure/storage-blob');
const cors = require('cors');
const path = require('path');
require('dotenv').config();

const app = express();
const port = process.env.PORT || 3000;

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static('public'));

// Azure Storage configuration
const connectionString = process.env.AZURE_STORAGE_CONNECTION_STRING;
const containerName = 'user-submissions';

let blobServiceClient;
let containerClient;

// Initialize Azure Storage
async function initializeAzureStorage() {
    try {
        if (!connectionString) {
            console.log('Azure Storage connection string not found. Running in local mode.');
            return;
        }

        blobServiceClient = BlobServiceClient.fromConnectionString(connectionString);
        containerClient = blobServiceClient.getContainerClient(containerName);
        
        // Create container if it doesn't exist
        await containerClient.createIfNotExists({
            access: 'private'
        });
        
        console.log('Azure Blob Storage initialized successfully');
    } catch (error) {
        console.error('Error initializing Azure Storage:', error.message);
    }
}

// Store submission in Azure Blob Storage
async function storeSubmission(submissionData) {
    try {
        if (!containerClient) {
            console.log('Azure Storage not configured. Data:', submissionData);
            return { success: true, message: 'Stored locally (development mode)' };
        }

        const fileName = `submission-${Date.now()}-${Math.random().toString(36).substr(2, 9)}.json`;
        const blobClient = containerClient.getBlockBlobClient(fileName);
        
        const dataString = JSON.stringify(submissionData, null, 2);
        
        await blobClient.upload(dataString, dataString.length, {
            blobHTTPHeaders: {
                blobContentType: 'application/json'
            }
        });
        
        console.log(`Submission stored in blob: ${fileName}`);
        return { 
            success: true, 
            message: 'Submission stored successfully',
            blobName: fileName 
        };
    } catch (error) {
        console.error('Error storing submission:', error.message);
        return { 
            success: false, 
            message: 'Error storing submission: ' + error.message 
        };
    }
}

// Get recent submissions from Azure Blob Storage
async function getRecentSubmissions(limit = 10) {
    try {
        if (!containerClient) {
            return [];
        }

        const submissions = [];
        
        for await (const blob of containerClient.listBlobsFlat()) {
            if (submissions.length >= limit) break;
            
            const blobClient = containerClient.getBlockBlobClient(blob.name);
            const downloadResponse = await blobClient.download();
            const downloadedContent = await streamToText(downloadResponse.readableStreamBody);
            
            try {
                const submissionData = JSON.parse(downloadedContent);
                submissions.push({
                    ...submissionData,
                    blobName: blob.name,
                    lastModified: blob.properties.lastModified
                });
            } catch (parseError) {
                console.error('Error parsing blob content:', parseError.message);
            }
        }
        
        // Sort by timestamp (newest first)
        submissions.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));
        return submissions.slice(0, limit);
        
    } catch (error) {
        console.error('Error retrieving submissions:', error.message);
        return [];
    }
}

// Helper function to convert stream to text
async function streamToText(readable) {
    readable.setEncoding('utf8');
    let data = '';
    for await (const chunk of readable) {
        data += chunk;
    }
    return data;
}

// Routes
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// API endpoint to submit form data
app.post('/api/submit', async (req, res) => {
    try {
        const { name, email, category, message } = req.body;
        
        // Validate required fields
        if (!name || !email || !message) {
            return res.status(400).json({
                success: false,
                message: 'Name, email, and message are required fields'
            });
        }
        
        // Create submission object
        const submissionData = {
            id: Date.now().toString(),
            name: name.trim(),
            email: email.trim().toLowerCase(),
            category: category || 'feedback',
            message: message.trim(),
            timestamp: new Date().toISOString(),
            userAgent: req.get('User-Agent'),
            ip: req.ip
        };
        
        // Store in Azure Blob Storage
        const result = await storeSubmission(submissionData);
        
        res.json({
            success: result.success,
            message: result.message,
            submissionId: submissionData.id
        });
        
    } catch (error) {
        console.error('Error processing submission:', error.message);
        res.status(500).json({
            success: false,
            message: 'Internal server error'
        });
    }
});

// API endpoint to get recent submissions
app.get('/api/submissions', async (req, res) => {
    try {
        const limit = parseInt(req.query.limit) || 10;
        const submissions = await getRecentSubmissions(limit);
        
        res.json({
            success: true,
            data: submissions,
            count: submissions.length
        });
        
    } catch (error) {
        console.error('Error fetching submissions:', error.message);
        res.status(500).json({
            success: false,
            message: 'Error fetching submissions'
        });
    }
});

// Health check endpoint
app.get('/api/health', (req, res) => {
    res.json({
        status: 'healthy',
        timestamp: new Date().toISOString(),
        storage: !!containerClient ? 'connected' : 'not configured'
    });
});

// Initialize and start server
async function startServer() {
    await initializeAzureStorage();
    
    app.listen(port, () => {
        console.log(`Server running at http://localhost:${port}`);
        console.log(`Storage status: ${containerClient ? 'Connected to Azure' : 'Local development mode'}`);
    });
}

startServer().catch(console.error);