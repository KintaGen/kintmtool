import toolCall from "./tool-call";

type RawEvent = {
    body: string;
}

type ParsedEvent = {
    args: Record<string, string>;
    secrets: Record<string, string>;
}

export async function handler(event: RawEvent) {
    const {
        args: {
            EXAMPLE_PARAM_ONE,
            EXAMPLE_PARAM_TWO,
        },
        secrets: {
            ENV_VAR_ONE
        }
    } = JSON.parse(event.body) as ParsedEvent;

    try {
        const result = await toolCall(EXAMPLE_PARAM_ONE, EXAMPLE_PARAM_TWO, ENV_VAR_ONE)

        return {
            statusCode: 200,
            body: JSON.stringify(result),
        };
    } catch (error: unknown) {
        let message = '';

        if (error instanceof Error) {
            message = error.message;
        } else {
            message = 'Unknown error';
        }

        return {
            statusCode: 500,
            body: JSON.stringify(message),
        };
    }
}
