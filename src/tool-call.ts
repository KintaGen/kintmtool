import axios from 'axios';
import FormData from 'form-data';
import { Buffer } from 'buffer';

/**
 * Decodes a Base64 plot string and uploads it as a file.
 * (This helper function is correct and remains unchanged)
 */
async function uploadPlot(
    plotB64: string,
    fileName: string,
    uploadEndpoint: string
): Promise<any> {
    console.log(`Preparing to upload plot: ${fileName}`);
    const base64Data = plotB64.split(',')[1];
    if (!base64Data) {
        throw new Error(`Invalid plot_b64 format for ${fileName}.`);
    }
    const plotBuffer = Buffer.from(base64Data, 'base64');
    const form = new FormData();
    form.append('file', plotBuffer, fileName);
    form.append('dataType', 'analysis');
    form.append('title', fileName.split('.')[0]);
    const uploadResponse = await axios.post(uploadEndpoint, form, {
        headers: form.getHeaders(),
    });
    console.log(`Successfully uploaded ${fileName}. Response:`, uploadResponse.data);
    return uploadResponse.data;
}


export default async function toolCall(
    dataUrlFragment: string,
    dataType: string,
    envVars: {
        API_URL: string
    }
): Promise<any> {

    console.log(`Preparing to call API at: ${envVars.API_URL} for data type: ${dataType}`);

    const uploadEndpoint = `${envVars.API_URL}/upload`;
    let endpointUrl: string | undefined;

    if (dataType === "DL50") {
        endpointUrl = `${envVars.API_URL}/analyze-ld50`;
    } else if (dataType === "GCMS") {
        endpointUrl = `${envVars.API_URL}/analyze-gcms`;
    }

    if (!endpointUrl) {
        return { success: false, message: "Must define dataType as 'DL50' or 'GCMS'" };
    }

    const requestPayload = { dataUrl: dataUrlFragment };

    try {
        // Step 1: Call the analysis endpoint
        console.log(`[Step 1/2] Sending POST request to ${endpointUrl}`);
        const response = await axios.post(endpointUrl, requestPayload, {
            headers: { 'Content-Type': 'application/json' }
        });
        const analysisResult = response.data;
        console.log('Successfully received analysis response.');

        if (analysisResult.status !== 'success') {
            throw new Error(`Analysis failed: ${analysisResult.error || 'Unknown error'}`);
        }

        // Step 2: Process results and upload plots
        console.log(`[Step 2/2] Processing results and uploading plots...`);
        
        if (dataType === "DL50") {
            // This logic remains the same for the LD50 script
            if (!analysisResult.results?.plot_b64) {
                 throw new Error("DL50 analysis did not return a 'plot_b64' string.");
            }
            const uploadData = await uploadPlot(
                analysisResult.results.plot_b64,
                'ld50_analysis_plot.png',
                uploadEndpoint
            );
            delete analysisResult.results.plot_b64;
            return { ...analysisResult, upload: uploadData };

        } else if (dataType === "GCMS") {
            // --- NEW, CORRECTED LOGIC FOR GCMS ---
            if (!analysisResult.results || typeof analysisResult.results !== 'object') {
                throw new Error("GCMS analysis did not return a results object.");
            }
            
            const uploadedPlots: { [key: string]: any } = {};
            const plotUploadPromises: Promise<void>[] = [];
            
            // Loop over all keys in the results object to find plots
            for (const key in analysisResult.results) {
                // Identify plots by the '_b64' suffix convention from the R script
                if (Object.prototype.hasOwnProperty.call(analysisResult.results, key) && key.endsWith('_b64')) {
                    const plotB64 = analysisResult.results[key];
                    const plotName = key.replace(/_b64$/, ''); // e.g., "pca_plot_b64" -> "pca_plot"
                    const fileName = `${plotName}.png`;

                    // Add the upload task to an array of promises to run in parallel
                    plotUploadPromises.push(
                        uploadPlot(plotB64, fileName, uploadEndpoint)
                            .then(uploadData => {
                                // When a plot is uploaded, store its CID/URL data
                                uploadedPlots[plotName] = uploadData;
                            })
                    );
                    
                    // IMPORTANT: Delete the large Base64 string from the results object now
                    // that we've captured it. This keeps the final response lightweight.
                    delete analysisResult.results[key];
                }
            }
            delete analysisResult.results.stats_table;

            // Wait for all plot uploads to complete
            await Promise.all(plotUploadPromises);

            // Return the analysis data (e.g., stats_table) plus the new 'uploads' object
            return {
                ...analysisResult,
                uploads: uploadedPlots // e.g., { pca_plot: {cid,...}, volcano_plot: {cid,...} }
            };
        }

    } catch (error: any) {
        console.error('An error occurred during the tool call process.');
        if (error.response) {
            console.error('API Error Response:', error.response.data);
            throw new Error(`API call failed with status ${error.response.status}: ${JSON.stringify(error.response.data)}`);
        } else if (error.request) {
            throw new Error(`No response received from API. Is the server at ${envVars.API_URL} running?`);
        } else {
            throw new Error(`Error setting up API request or processing response: ${error.message}`);
        }
    }
}