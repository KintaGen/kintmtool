import axios from 'axios';
import FormData from 'form-data';
import { Buffer } from 'buffer';
import archiver from 'archiver'; // <-- NEW: The Node.js-native zipping library

/**
 * Creates a zip archive from analysis results, uploads it in a single call,
 * and returns the upload response.
 * @param results - The `results` object from the analysis API call.
 * @param reportBaseName - A base name for the files, e.g., 'ld50_analysis'.
 * @param uploadEndpoint - The URL to upload the final zip file to.
 * @returns The data from the upload API response.
 */
async function createAndUploadReportZip(
    results: any,
    reportBaseName: string,
    uploadEndpoint: string
): Promise<any> {
    if (!results || typeof results !== 'object') {
        throw new Error("Analysis did not return a valid results object.");
    }
    
    console.log(`Creating a zip archive for ${reportBaseName}...`);
    // --- NEW LOGIC using archiver ---
    // We create an in-memory zip archive stream.
    const archive = archiver('zip', {
        zlib: { level: 9 } // Sets the compression level.
    });

    // We will collect the zip data into an array of buffers.
    const chunks: Buffer[] = [];
    archive.on('data', (chunk: any) => chunks.push(chunk));
    
    // Create a promise that resolves when the archive is finished.
    const archiveFinished = new Promise((resolve, reject) => {
        archive.on('end', resolve);
        archive.on('error', reject);
    });
    // Find all plot strings (ending in _b64), add them as images to the zip,
    // and then remove them from the original results object.
    for (const key in results) {
        if (Object.prototype.hasOwnProperty.call(results, key) && key.endsWith('_b64')) {
            const plotB64 = results[key];
            const plotName = key.replace(/_b64$/, ''); // e.g., "pca_plot_b64" -> "pca_plot"
            const fileName = `${plotName}.png`;

            const base64Data = plotB64.split(',')[1];
            if (!base64Data) {
                console.warn(`Skipping invalid base64 format for ${key}.`);
                continue;
            }
            const plotBuffer = Buffer.from(base64Data, 'base64');
            
            // Append the plot buffer to the archive with its filename.
            archive.append(plotBuffer, { name: fileName });
            console.log(`Added ${fileName} to zip archive.`);
            
            delete results[key]; // Remove large string from results
        }
    }
    
    // Add the remaining lightweight JSON data (e.g., stats) to the zip.
    const jsonData = JSON.stringify(results, null, 2);
    // Append the JSON string to the archive with its filename.
    archive.append(jsonData, { name: 'analysis_data.json' });
    console.log('Added analysis_data.json to zip archive.');

    // Finalize the archive. This signals that we are done adding files.
    await archive.finalize();
    
    // Wait for the stream to finish writing all its data.
    await archiveFinished;

    // Combine all the collected buffer chunks into a single buffer.
    const zipBuffer = Buffer.concat(chunks);

    // Prepare and upload the single zip file.
    const zipFileName = `${reportBaseName}_report.zip`;
    const form = new FormData();
    form.append('file', zipBuffer, zipFileName);
    form.append('dataType', 'analysis_report'); // Consistent type for reports
    form.append('title', reportBaseName.replace(/_/g, ' ') + ' report');
    
    console.log(`Uploading single report: ${zipFileName}`);
    const uploadResponse = await axios.post(uploadEndpoint, form, {
        headers: form.getHeaders(),
    });
    console.log(`Successfully uploaded ${zipFileName}. Response:`, uploadResponse.data);
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
    let reportBaseName: string | undefined;

    if (dataType === "DL50") {
        endpointUrl = `${envVars.API_URL}/analyze/ld50`;
        reportBaseName = 'ld50_analysis';
    } else if (dataType === "GCMS") {
        endpointUrl = `${envVars.API_URL}/analyze/gcms-profiling`;
        reportBaseName = 'gcms_analysis';
    }

    if (!endpointUrl || !reportBaseName) {
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

        // Step 2: Create a zip report and upload it in a single transaction
        console.log(`[Step 2/2] Creating and uploading analysis report...`);
        
        const uploadData = await createAndUploadReportZip(
            analysisResult.results,
            reportBaseName,
            uploadEndpoint
        );
        
        // The results object passed to the helper is modified by reference (keys are deleted),
        // so analysisResult is now lightweight.
        return {
            ...analysisResult,
            upload: uploadData
        };

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