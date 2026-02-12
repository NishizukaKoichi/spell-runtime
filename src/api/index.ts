import { startExecutionApiServer } from "./server";

async function main(): Promise<void> {
  const port = Number(process.env.SPELL_API_PORT ?? "8787");
  const registryPath = process.env.SPELL_BUTTON_REGISTRY_PATH;

  const started = await startExecutionApiServer({
    port,
    registryPath
  });

  process.stdout.write(`spell execution api listening on :${started.port}\n`);
}

main().catch((error) => {
  process.stderr.write(`${(error as Error).message}\n`);
  process.exitCode = 1;
});
