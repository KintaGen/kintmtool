const dotenv = require('dotenv');
const express = require('express');
const { handler } = require('../dist/index');

dotenv.config();

const app = express();

const { SYNAPSE_PRIVATE_KEY, SYNAPSE_NETWORK,SYNAPSE_RPC_URL,PORT } = process.env;

if(SYNAPSE_PRIVATE_KEY === undefined) {
    console.log('`SYNAPSE_PRIVATE_KEY` not set. Copy .env.example to .env first.');
    process.exit(1);
}
if(SYNAPSE_NETWORK === undefined) {
    console.log('`SYNAPSE_NETWORK` not set. Copy .env.example to .env first.');
    process.exit(1);
}
if(SYNAPSE_RPC_URL === undefined) {
    console.log('`SYNAPSE_RPC_URL` not set. Copy .env.example to .env first.');
    process.exit(1);
}
app.get('/', async (req, res) => {
    const { url } = req.query;
    res.send(url);

    /*
    const event = {
        body: JSON.stringify({
            args: {
                url,
            },
            secrets: {
                SYNAPSE_PRIVATE_KEY,
                SYNAPSE_NETWORK,
                SYNAPSE_RPC_URL
            }
        })
    }

    const result = await handler(event)

    res.status(result.statusCode).send(result.body);
    */
});

const port = PORT || 3000;
app.listen(port, () => {
    console.log(`Local development server running on port ${port}`);
});
