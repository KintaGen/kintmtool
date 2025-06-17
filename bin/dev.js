const dotenv = require('dotenv');
const express = require('express');
const { handler } = require('../dist/index');

dotenv.config();

const app = express();

const { ENV_VAR_ONE, PORT } = process.env;

if(ENV_VAR_ONE === undefined) {
    console.log('`ENV_VAR_ONE` not set. Copy .env.example to .env first.');
    process.exit(1);
}

app.get('/', async (req, res) => {
    const { EXAMPLE_PARAM_ONE, EXAMPLE_PARAM_TWO } = req.query;

    const event = {
        body: JSON.stringify({
            args: {
                EXAMPLE_PARAM_ONE,
                EXAMPLE_PARAM_TWO
            },
            secrets: {
                ENV_VAR_ONE
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
