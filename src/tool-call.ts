import path from 'path';
import fs from 'fs';
import axios from 'axios';
import { levenbergMarquardt,ParameterizedFunction } from 'ml-levenberg-marquardt';

import ChartJsImage from 'chartjs-to-image';


import { uploadData, UploadResult } from './synapse'; // MUST include .js extension

// --- Configuration ---
const filCdnBaseUrl = "https://0xcdb8cc9323852ab3bed33f6c54a7e0c15d555353.calibration.filcdn.io/";
const resultsDir = path.join(__dirname, 'results');

// --- Helper Types ---
interface DoseData {
    dose: number[];
    response: number[];
    total: number[];
}

interface FitResult {
    ld50: number;
    slope: number;
}


function calculateMedian(arr: number[]): number {
  if (arr.length === 0) return 0;
  const mid = Math.floor(arr.length / 2);
  // Sort a copy of the array
  const nums = [...arr].sort((a, b) => a - b);
  return arr.length % 2 !== 0 ? nums[mid] : (nums[mid - 1] + nums[mid]) / 2;
}

// --- Statistical Functions (Re-implementing R's drc::LL.2 logic) ---

/**
 * The two-parameter log-logistic function (LL.2).
 * This function models the probability of a response at a given dose.
 * @param params - An array [b, e] where 'b' is the slope and 'e' is the LD50.
 * @param x - The dose value.
 * @returns The predicted proportion of response (between 0 and 1).
 */
const logLogistic2 = (params: number[], x: number): number => {
    const [b, e] = params; // b: slope, e: LD50 (or ED50)
    if (x <= 0 || e <= 0) return 0; // Log of non-positive is undefined
    return 1 / (1 + Math.exp(b * (Math.log(x) - Math.log(e))));
};



// We redefine the fitting function to match the library's expected "function that returns a function" signature.
// This new function will be used to trick the optimizer.

const fittingFunctionForLM = (data: DoseData): ParameterizedFunction => {
  // 1. This outer function takes the parameters being optimized (b, e)
  return (params: number[]) => {
      // 2. It calculates the negative log-likelihood, just like before.
      let negLogLikelihood = 0;
      const { dose, response, total } = data;
      for (let i = 0; i < dose.length; i++) {
          if (dose[i] <= 0) continue;
          const predictedProb = logLogistic2(params, dose[i]);
          const p = Math.max(1e-9, Math.min(1 - 1e-9, predictedProb));
          const successes = response[i];
          const trials = total[i];
          negLogLikelihood -= (successes * Math.log(p) + (trials - successes) * Math.log(1 - p));
      }
      
      // 3. It RETURNS A NEW FUNCTION. This inner function is what the library
      //    will evaluate. We make it ignore its input `x` and always return
      //    the calculated negative log-likelihood.
      return (_x: number) => negLogLikelihood;
  };
};

// --- The fitModel function is now updated to use the new fitting function ---
function fitModel(data: DoseData): FitResult {
  // Create the special function required by the library
  const parameterizedFunction = fittingFunctionForLM(data);
  
  // Provide good initial guesses
  const proportions = data.response.map((r, i) => r / data.total[i]);
  const halfEffectIndex = proportions.map(p => Math.abs(p - 0.5)).indexOf(Math.min(...proportions.map(p => Math.abs(p - 0.5))));
  const initialLD50Guess = data.dose[halfEffectIndex] || calculateMedian(data.dose.filter(d => d > 0));

  const options = {
      initialValues: [1, initialLD50Guess],
      maxIterations: 500,
  };
  
  // --- THIS IS THE CRITICAL FIX ---
  // The library validates the length of the data arrays we pass in.
  // We must provide a "dummy" dataset that has enough points to pass this check.
  // The actual values don't matter because our custom `fittingFunctionForLM` ignores them.
  // We'll create an array of indices with the same length as our real data.
  const dummyX = Array.from({ length: data.dose.length }, (_, i) => i);
  const dummyY = Array.from({ length: data.dose.length }, () => 0); // Y values can all be 0
  const dummyData = { x: dummyX, y: dummyY };

  // The call now matches the expected signature: (data, function, options)
  const { parameterValues } = levenbergMarquardt(dummyData, parameterizedFunction, options);
  
  return {
      slope: parameterValues[0],
      ld50: parameterValues[1],
  };
}

/**
 * Calculates the 95% confidence interval for the LD50 using the bootstrap method.
 * @param data - The original dataset.
 * @param iterations - Number of bootstrap samples to run (e.g., 1000).
 * @returns The lower and upper bounds of the confidence interval.
 */
function getBootstrapCI(data: DoseData, iterations = 1000): { lower: number; upper: number } {
    const ld50Estimates: number[] = [];
    const n = data.dose.length;

    for (let i = 0; i < iterations; i++) {
        // Create a resampled dataset with replacement
        const resampledData: DoseData = { dose: [], response: [], total: [] };
        for (let j = 0; j < n; j++) {
            const randomIndex = Math.floor(Math.random() * n);
            resampledData.dose.push(data.dose[randomIndex]);
            resampledData.response.push(data.response[randomIndex]);
            resampledData.total.push(data.total[randomIndex]);
        }
        
        try {
            const fit = fitModel(resampledData);
            // Only store valid, positive LD50 estimates
            if (fit && fit.ld50 > 0 && isFinite(fit.ld50)) {
                ld50Estimates.push(fit.ld50);
            }
        } catch (e) {
            // Ignore fits that fail on resampled data
        }
    }
    
    if (ld50Estimates.length < 50) { // Not enough successful fits
      return { lower: NaN, upper: NaN };
    }

    ld50Estimates.sort((a, b) => a - b);
    const lowerIndex = Math.floor(0.025 * ld50Estimates.length);
    const upperIndex = Math.ceil(0.975 * ld50Estimates.length);

    return {
        lower: ld50Estimates[lowerIndex],
        upper: ld50Estimates[upperIndex],
    };
}

// --- Plotting Function (Re-implementing ggplot2) ---

/**
 * Generates a dose-response plot and saves it to a file.
 * @param data - The original data.
 * @param fit - The results from the model fit.
 * @param filePath - The path to save the generated JPEG.
 */
async function generatePlot(
  data: DoseData,
  fit: FitResult,
  filePath: string
): Promise<void> {

  // --- 1. Prepare Data for Chart.js ---
  const scatterData = data.dose.map((d, i) => ({ x: d, y: data.response[i] / data.total[i] }));
  const minDose = Math.min(...data.dose.filter(d => d > 0));
  const maxDose = Math.max(...data.dose);
  const curvePoints = [];
  for (let i = 0; i < 100; i++) {
      const dose = Math.exp(Math.log(minDose) + (Math.log(maxDose) - Math.log(minDose)) * (i / 99));
      curvePoints.push({ x: dose, y: logLogistic2([fit.slope, fit.ld50], dose) });
  }

  // --- 2. Define the Chart.js Configuration ---
  // This is a standard Chart.js v3/v4 config object.
  const chartConfig = {
      type: 'scatter',
      data: {
          datasets: [
              {
                  type: 'line',
                  label: 'Fitted Curve',
                  data: curvePoints,
                  borderColor: 'blue',
                  borderWidth: 2,
                  fill: false,
                  pointRadius: 0,
              },
              {
                  label: 'Observed Data',
                  data: scatterData,
                  backgroundColor: 'black',
                  type: 'scatter',
                  pointRadius: 5,
              },
          ],
      },
      options: {
          plugins: {
              title: {
                  display: true,
                  text: 'Dose-Response Curve with LD50 Estimate',
                  font: { size: 18, weight: 'bold' }
              },
              legend: { display: false },
              // We will add annotations after confirming the base chart renders.
          },
          scales: {
              x: {
                  type: 'logarithmic',
                  title: { display: true, text: 'Dose (log scale)' },
                  min: minDose,
              },
              y: {
                  title: { display: true, text: 'Response Proportion' },
                  min: 0,
                  max: 1,
              },
          },
      },
  };

  // --- 3. Render the chart using chartjs-to-image ---
  const chart = new ChartJsImage();
  chart.setConfig(chartConfig);
  chart.setWidth(800).setHeight(600);
  chart.setBackgroundColor('white');
  console.log(chart)
  // Get the image buffer
  const imageBuffer = await chart.toBinary();

  // Save the file
  fs.writeFileSync(filePath, imageBuffer);
  console.log(`Plot saved successfully to ${filePath}`);
}


// --- Main Exported Function ---

/**
 * Orchestrates the full LD50 analysis in pure Node.js.
 * @param url The unique part of the data filcdn URL 
 * @returns A promise that resolves to a final JSON string with all results.
 */
export default async function toolCall(
  url: string,
  synapseEnv: {
    SYNAPSE_PRIVATE_KEY: string,
    SYNAPSE_NETWORK: string,
    SYNAPSE_RPC_URL: string
  }
): Promise<string> {
    return "test";

    let finalOutput = {};
    const outputPlotPath = path.join(resultsDir, 'ld50_plot.jpeg');

    try {
        // 1. Prepare environment
        if (!fs.existsSync(resultsDir)) {
            fs.mkdirSync(resultsDir, { recursive: true });
        }
        
        // 2. Download and Parse Data
        console.log(`Downloading data from ${filCdnBaseUrl}${url}...`);
        const response = await axios.get(`${filCdnBaseUrl}${url}`);
        const csvData = response.data;
        // ... (parsing logic remains the same)
        const lines = csvData.trim().split('\n');
        const header = lines.shift()!.trim().split(',');
        const data: DoseData = { dose: [], response: [], total: [] };
        
        const colMap: { [key: string]: number } = {};
        header.forEach((h: string, i: number) => colMap[h.trim()] = i);
        if (!['dose', 'response', 'total'].every(h => h in colMap)) {
            throw new Error(`Input CSV must contain columns: dose, response, total`);
        }

        for (const line of lines) {
            const values = line.trim().split(',');
            data.dose.push(parseFloat(values[colMap.dose]));
            data.response.push(parseInt(values[colMap.response], 10));
            data.total.push(parseInt(values[colMap.total], 10));
        }
        console.log('Data parsed successfully.');
        if (data.dose.length < 3) {
          throw new Error(`Insufficient data: At least 3 data points (rows) are required for LD50 analysis, but found ${data.dose.length}.`);
        }
        // 3. Perform Dose-Response Modeling
        console.log('Fitting log-logistic model...');
        const fit = fitModel(data);
        console.log(`Model fit complete. LD50 = ${fit.ld50}`);

        // 4. Calculate Confidence Intervals
        console.log('Calculating confidence intervals via bootstrapping...');
        const ci = getBootstrapCI(data);
        console.log(`Confidence Interval: [${ci.lower}, ${ci.upper}]`);

        // 5. Generate Plot
        console.log('Generating plot...');
        await generatePlot(data, fit, outputPlotPath);
        console.log(`Plot saved to ${outputPlotPath}`);

        // --- SECTION 6: MODIFIED UPLOAD LOGIC ---

        // 6a. Read the generated plot file into a buffer and encode it as a Base64 Data URI
        console.log('Encoding plot as Base64 Data URI...');
        const plotBuffer = fs.readFileSync(outputPlotPath);
        console.log('Uploading plot to filcdn ...');

        const plotUploadResult: UploadResult = await uploadData(plotBuffer, { proofSetId: 318 },synapseEnv); 
        const plotDataUri = `data:image/jpeg;base64,${plotBuffer.toString('base64')}`;

        // 6b. Assemble the complete JSON payload containing results and the embedded plot
        const uploadPayload = {
            ld50_estimate: fit.ld50,
            standard_error: null, // Bootstrap CI doesn't directly produce a standard error
            confidence_interval_lower: ci.lower,
            confidence_interval_upper: ci.upper,
            model_details: {
                coefficients: {
                    slope_b: fit.slope,
                    ld50_e: fit.ld50
                },
                method: "Log-Logistic (LL.2) fit via Levenberg-Marquardt; 95% CI via Bootstrap"
            },
            plotDataUri: plotDataUri, // The plot is now embedded data
            plotDataCID: plotUploadResult.commp
        };

        // 6c. Convert the JSON payload object to a Buffer for upload
        const payloadBuffer = Buffer.from(JSON.stringify(uploadPayload, null, 2), 'utf-8');

        // 6d. Upload the entire payload buffer using the Synapse service function
        console.log(`Uploading combined results JSON (${(payloadBuffer.length / 1024).toFixed(2)} KB) via Synapse...`);
        
        // We use the proofSetId from the original script as an option.
        const uploadResult: UploadResult = await uploadData(payloadBuffer, { proofSetId: 318 },synapseEnv);

        console.log('Upload complete via Synapse. CommP:', uploadResult.commp);
        
        // --- SECTION 7: MODIFIED FINAL OUTPUT ---
        
        // 7. Assemble the final output, which now points to the uploaded JSON payload.
        finalOutput = {
            success: true,
            // The CID now points to the entire JSON object on FilCDN.
            resultCid: uploadResult.commp,
            proofSetId: uploadResult.proofSetId,
            message: "Successfully analyzed data and uploaded combined results JSON.",
        };

    } catch (error: any) {
        console.error("An error occurred during the process:", error.message);
        finalOutput = { success: false, error: error.message };
    } finally {
        // We leave the plot file for inspection, but you could add cleanup here.
    }

    return JSON.stringify(finalOutput, null, 2);
}

// Add a declaration for the custom Math.median function to satisfy TypeScript
declare global {
    interface Math {
        median(arr: number[]): number;
    }
}