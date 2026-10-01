// Process entry for `bun src/main.ts` and for the compiled standalone executable.
import { main } from "./index.ts";

await main(process.argv);
