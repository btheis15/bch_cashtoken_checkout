// The demo's network is simulated (../test/fakes.mjs), so the real Fulcrum client is never created.
export class ElectrumClient {
  constructor() {
    throw new Error("The demo uses a simulated network.");
  }
}
