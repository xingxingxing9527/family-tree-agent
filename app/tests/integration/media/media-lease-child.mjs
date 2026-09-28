const [moduleUrl, directory, hash, optionsJson] = process.argv.slice(2);

const send = (message) => {
  if (process.connected) process.send(message);
};

try {
  const { acquireHashLease } = await import(moduleUrl);
  const lease = await acquireHashLease(directory, hash, JSON.parse(optionsJson));
  send({ type: "acquired", token: lease.token });

  process.on("message", async (message) => {
    try {
      if (message === "assert") {
        await lease.assertOwned();
        send({ type: "asserted" });
      } else if (message === "release") {
        send({ type: "released", released: await lease.release() });
        process.disconnect();
      }
    } catch (error) {
      send({ type: "error", message: error instanceof Error ? error.message : String(error) });
      process.disconnect();
    }
  });
} catch (error) {
  send({ type: "error", message: error instanceof Error ? error.message : String(error) });
  process.disconnect();
}
