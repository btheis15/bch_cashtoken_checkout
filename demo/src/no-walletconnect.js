// The demo's wallet is simulated (src/shop.js), so WalletConnect's client is never loaded.
export const SignClient = {
  init() {
    throw new Error("The demo uses a simulated wallet.");
  },
};
export default SignClient;
