import { spawn } from 'child_process';
import path from 'path';

// Helper function to run external scripts as a promise
function runScript(command: string, args: string[], options = {}): Promise<string> {
    // The 'options' object can now include 'cwd' to set the working directory
    return new Promise((resolve, reject) => {
      console.log(`Spawning: ${command} ${args.join(' ')}`);
      const process = spawn(command, args, options);
      console.log("test")
      let stdout = '';
      let stderr = '';
  
      process.stdout.on('data', (data) => {
        console.log(`[${command} stdout]: ${data}`);
        stdout += data.toString();
      });
  
      process.stderr.on('data', (data) => {
        console.error(`[${command} stderr]: ${data}`);
        stderr += data.toString();
      });
  
      process.on('close', (code) => {
        if (code !== 0) {
          return reject(new Error(`Process ${command} exited with code ${code}\n${stderr}`));
        }
        resolve(stdout);
      });
  
      process.on('error', (err) => {
        reject(err);
      });
    });
}


export default async function toolCall(paramOne: string, paramTwo: string, envVar: string): Promise<string> {
    let result = '';
    const dataUrl = paramOne;
    const r_script_path = path.join(__dirname, 'scripts', 'ld50_analysis.R');
    console.log(`Received event with the following parameters: ${paramOne}, ${paramTwo} and the following env var: ${envVar}.`)

    result = paramOne + paramTwo;
    const command = 'Rscript';
    const args = [r_script_path, dataUrl];

    console.log(`Starting LD50 R script with URL: ${dataUrl}`);
    const scriptOutputJson = await runScript(command, args);

    const results = JSON.parse(scriptOutputJson);
    return results;
}
