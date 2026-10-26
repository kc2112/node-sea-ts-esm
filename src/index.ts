import { initChrome } from "./init.js";
import { greet } from "./greet.js";

// Ensure headless Chrome is extracted and CHROME_CACHE is set
const chromePath = initChrome();
console.log(`Chrome ready: ${chromePath}`);

const name = process.argv[2] ?? "world";
console.log(greet(name));
console.log(`Node ${process.version} | SEA binary`);
