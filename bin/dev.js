const dotenv = require('dotenv');
const express = require('express');
const { handler } = require('../dist/index');

dotenv.config();

const app = express();

const { API_URL,PORT } = process.env;

if(API_URL === undefined) {
    console.log('`API_URL` not set. Copy .env.example to .env first.');
    process.exit(1);
}

app.get('/', async (req, res) => {
    const { url } = req.query;
    
    
    const event = {
        body: JSON.stringify({
            args: {
                url,
            },
            secrets: {
                API_URL,
            }
        })
    }

    const result = await handler(event)

    res.status(result.statusCode).send(result.body);
    
});

const port = PORT || 3000;
app.listen(port, () => {
    console.log(`Local development server running on port ${port}`);
});
