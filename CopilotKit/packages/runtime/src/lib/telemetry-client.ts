import { TelemetryClient } from "@copilotkit-alt/shared";
const packageJson = require("../../package.json");

const telemetryClient = new TelemetryClient({
  packageName: packageJson.name,
  packageVersion: packageJson.version,
});

export default telemetryClient;
