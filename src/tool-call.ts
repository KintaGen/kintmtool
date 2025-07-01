import path from 'path';
import axios from 'axios';

import ChartJsImage from 'chartjs-to-image';


import { uploadData, UploadResult } from './synapse'; // MUST include .js extension

// --- Configuration ---
// const filCdnBaseUrl = "https://0xcdb8cc9323852ab3bed33f6c54a7e0c15d555353.calibration.filcdn.io/";

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





function negativeLogLikelihood(params: number[], data: DoseData): number {
  let nll = 0;
  const { dose, response, total } = data;
  for (let i = 0; i < dose.length; i++) {
      const d = dose[i];
      if (d <= 0) continue;
      const p = logLogistic2(params, d);
      const p_clipped = Math.max(1e-9, Math.min(1 - 1e-9, p));
      nll -= (response[i] * Math.log(p_clipped) + (total[i] - response[i]) * Math.log(1 - p_clipped));
  }
  return nll;
}

// --- THE FINAL, VERIFIED, AND SIMPLER fitModel FUNCTION ---
function nelderMead(
  f: (x: number[]) => number,
  x0: number[]
): { x: number[], fx: number } {
  const n = x0.length;
  const maxIter = 2000;
  const step = 0.1;
  const tol = 1e-6;

  // Create initial simplex
  let simplex = [x0.slice()];
  for (let i = 0; i < n; i++) {
      const point = x0.slice();
      point[i] += step;
      simplex.push(point);
  }

  for (let iter = 0; iter < maxIter; iter++) {
      // 1. Order simplex by function value
      simplex.sort((a, b) => f(a) - f(b));

      // Check for convergence
      if (f(simplex[n]) - f(simplex[0]) < tol) {
          break;
      }

      // 2. Calculate centroid of all points except the worst
      const centroid = new Array(n).fill(0);
      for (let i = 0; i < n; i++) {
          for (let j = 0; j < n; j++) {
              centroid[j] += simplex[i][j] / n;
          }
      }

      const worstPoint = simplex[n];

      // 3. Reflection
      const reflected = centroid.map((c, i) => c + (c - worstPoint[i]));
      const f_r = f(reflected);

      if (f(simplex[0]) <= f_r && f_r < f(simplex[n - 1])) {
          simplex[n] = reflected;
          continue;
      }

      // 4. Expansion
      if (f_r < f(simplex[0])) {
          const expanded = centroid.map((c, i) => c + 2 * (reflected[i] - c));
          if (f(expanded) < f_r) {
              simplex[n] = expanded;
          } else {
              simplex[n] = reflected;
          }
          continue;
      }

      // 5. Contraction
      const contracted = centroid.map((c, i) => c + 0.5 * (worstPoint[i] - c));
      if (f(contracted) < f(worstPoint)) {
          simplex[n] = contracted;
          continue;
      }

      // 6. Shrink
      for (let i = 1; i <= n; i++) {
          simplex[i] = simplex[0].map((s0, j) => s0 + 0.5 * (simplex[i][j] - s0));
      }
  }

  return { x: simplex[0], fx: f(simplex[0]) };
}


// --- The NEW fitModel function that uses our own algorithm ---
function fitModel(data: DoseData): FitResult {
  const objectiveFn = (p: number[]) => {
      // Add a penalty for non-positive parameters to guide the optimizer
      if (p[1] <= 0) return 1e9; // If LD50 is non-positive, return a large number
      return negativeLogLikelihood(p, data);
  };

  const proportions = data.response.map((r, i) => r / data.total[i]);
  const halfEffectIndex = proportions.map(p => Math.abs(p - 0.5)).indexOf(Math.min(...proportions.map(p => Math.abs(p - 0.5))));
  let initialLD50Guess = data.dose[halfEffectIndex] || calculateMedian(data.dose.filter(d => d > 0));
  if (initialLD50Guess <= 0) initialLD50Guess = 0.1;
  
  const initialParams = [1.0, initialLD50Guess];

  // Call our own, internal Nelder-Mead function
  const result = nelderMead(objectiveFn, initialParams);
  
  const finalParams = result.x;

  return {
      slope: finalParams[0],
      ld50: finalParams[1],
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
 */
async function generatePlot(
  data: DoseData,
  fit: FitResult
): Promise<Buffer> {

  // --- 1. Prepare Data for Chart.js ---
  const scatterData = data.dose.map((d, i) => ({ x: d, y: data.response[i] / data.total[i] }));
  const minDose = Math.min(...data.dose.filter(d => d > 0));
  const maxDose = Math.max(...data.dose);
  const curvePoints = [];
  // Step 1: Get the start and end points in log10 space
  const log10MinDose = Math.log10(minDose);
  const log10MaxDose = Math.log10(maxDose);
  const log10Range = log10MaxDose - log10MinDose;

  for (let i = 0; i < 100; i++) {
      // Step 2: Create an evenly spaced point IN LOG10 SPACE
      const log10Dose = log10MinDose + log10Range * (i / 99);

      // Step 3: Convert the log10 point BACK to normal dose space
      const dose = 10 ** log10Dose; // This is the same as Math.pow(10, log10Dose)
      
      // Step 4: Calculate the curve's y-value for that dose
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
  // Get the image buffer
  const imageBuffer = await chart.toBinary();

  return(imageBuffer);
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
): Promise<object> {
    
    let finalOutput = {};

    try {

        
        // 2. Download and Parse Data
        console.log(`Downloading data from ${url}...`);
        const response = await axios.get(`${url}`);
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
        const plotBuffer = await generatePlot(data, fit);
        console.log(`Plot done`);

        // --- SECTION 6: MODIFIED UPLOAD LOGIC ---

        // 6a. Read the generated plot file into a buffer and encode it as a Base64 Data URI
        console.log('Encoding plot as Base64 Data URI...');
        console.log('Uploading plot to filcdn ...');

        //const plotUploadResult: UploadResult = await uploadData(plotBuffer, { proofSetId: 318 },synapseEnv); 
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
            //plotDataCID: plotUploadResult.commp
        };

        /* 6c. Convert the JSON payload object to a Buffer for upload
        const payloadBuffer = Buffer.from(JSON.stringify(uploadPayload, null, 2), 'utf-8');

        // 6d. Upload the entire payload buffer using the Synapse service function
        console.log(`Uploading combined results JSON (${(payloadBuffer.length / 1024).toFixed(2)} KB) via Synapse...`);
        
        // We use the proofSetId from the original script as an option.
        const uploadResult: UploadResult = await uploadData(payloadBuffer, { proofSetId: 318 },synapseEnv);

        console.log('Upload complete via Synapse. CommP:', uploadResult.commp);
        */
        // --- SECTION 7: MODIFIED FINAL OUTPUT ---
        
        // 7. Assemble the final output, which now points to the uploaded JSON payload.
        finalOutput = {
            success: true,
            // The CID now points to the entire JSON object on FilCDN.
            //resultCid: uploadResult.commp,
            //proofSetId: uploadResult.proofSetId,
            uploadPayload: uploadPayload,
            message: "Successfully analyzed data and uploaded combined results JSON.",
        };

    } catch (error: any) {
        console.error("An error occurred during the process:", error.message);
        finalOutput = { success: false, error: error.message };
    } 

    return(finalOutput);
}

// Add a declaration for the custom Math.median function to satisfy TypeScript
declare global {
    interface Math {
        median(arr: number[]): number;
    }
}