import axios from 'axios'; // Make sure you have axios installed: pnpm add axios
import FormData from 'form-data'; 



/**
 * This function acts as a client to an existing Express.js API endpoint
 * to perform LD50 analysis.
 *
 * @param {string} expressApiBaseUrl The base URL of the Express server (e.g., 'http://localhost:3000').
 * @param {string} dataUrlFragment The data identifier (e.g., a CID) for the analysis.
 * @returns {Promise<string>} A promise that resolves to the JSON string result from the API.
 */
export default async function toolCall(
    dataUrlFragment: string,
    envVars: {
        API_URL: string
    }
): Promise<string> {

    console.log(`Preparing to call Express API at: ${envVars.API_URL} for data: ${dataUrlFragment}`);

    // The full URL of the API endpoint we need to call
    const endpointUrl = `${envVars.API_URL}/analyze-ld50`;
    const uploadEndpoint = `${envVars.API_URL}/upload`;
    // The JSON payload that the /analyze-ld50 endpoint expects
    const requestPayload = {
        dataUrl: dataUrlFragment
    };

    try {
        console.log(`Sending POST request to ${endpointUrl} with payload:`, requestPayload);

        // Use axios to make the HTTP POST request
        const response = await axios.post(endpointUrl, requestPayload, {
            headers: {
                'Content-Type': 'application/json'
            }
        });

        // The response.data will contain the JSON object returned by the Express server
        const analysisResult = response.data;
        console.log(analysisResult.results)
        console.log('Successfully received response from Express API.');

        if (analysisResult.status !== 'success' || !analysisResult.results?.plot_b64) {
            throw new Error(`LD50 analysis failed or did not return a plot: ${analysisResult.error || 'Unknown error'}`);
        }       

        // Extract the Base64 data from the data URI string
        const base64Data = analysisResult.results.plot_b64.split(',')[1];
        if (!base64Data) {
            throw new Error("Invalid plot_b64 format received from analysis API.");
        }
        // Convert the Base64 string into a Buffer, which is what Node.js uses for binary data.
        const plotBuffer = Buffer.from(base64Data, 'base64');
        
        // Create a new FormData instance
        const form = new FormData();

        // Append all the required fields, just like in the client-side example
        form.append('file', plotBuffer, 'chat_analysis_plot.png'); // Add the buffer with a filename
        form.append('dataType', 'analysis');
        form.append('title', 'chat_analysis');
        //form.append('projectId', ''); // Send '' as a string 

        console.log(`[Step 2/2] Sending multipart/form-data request to ${uploadEndpoint}`);
        
        // Make the POST request to the upload endpoint
        const uploadResponse = await axios.post(uploadEndpoint, form);
        console.log(uploadResponse)
        console.log('[Step 2/2] Upload successful!');
        const callResponse = {
            results: analysisResult.results,
            ...uploadResponse.data
        }
        // Return the response from the final upload step
        return callResponse
    } catch (error: any) {
        console.error('An error occurred while calling the Express API.');
        
        // Axios wraps HTTP errors in a specific structure.
        // It's helpful to log the response data from the server if it exists.
        if (error.response) {
            console.error('API Error Response Status:', error.response.status);
            console.error('API Error Response Data:', error.response.data);
            // Re-throw a more informative error
            throw new Error(`API call failed with status ${error.response.status}: ${JSON.stringify(error.response.data)}`);
        } else if (error.request) {
            // The request was made but no response was received (e.g., server is down)
            throw new Error(`No response received from API at ${endpointUrl}. Is the server running?`);
        } else {
            // Something else went wrong in setting up the request
            throw new Error(`Error setting up API request: ${error.message}`);
        }
    }
}