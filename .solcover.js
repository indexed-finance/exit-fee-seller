require('dotenv').config()

module.exports = {
  skipFiles: ["interfaces/", "test/", "libraries/"],
  // Options for forking mainnet
  providerOptions: {
    allowUnlimitedContractSize: true,
    host: "localhost",
    port: 8545,
    network_id: "13255220",
    networkCheckTimeout: 60000,
    fork: `https://eth-mainnet.alchemyapi.io/v2/${process.env.ALCHEMY_API_KEY}`,
    fork_block_number: 13255220
  }
}