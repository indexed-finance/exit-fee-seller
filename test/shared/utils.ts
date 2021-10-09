import { ethers, network, waffle } from 'hardhat';
import { getCreate2Address } from '@ethersproject/address';
import { JsonRpcSigner } from '@ethersproject/providers';
import { keccak256 } from '@ethersproject/keccak256';
import { BigNumber, Contract } from 'ethers';
import { IERC20 } from '../../typechain/IERC20';
import { IUniswapV2Router, IWETH, IOracle, IUniswapV2Factory } from '../../typechain';

const factoryABI = require('../../artifacts/contracts/test/IUniswapV2Factory.sol/IUniswapV2Factory.json').abi;
const routerABI = require('../../artifacts/contracts/test/IUniswapV2Router.sol/IUniswapV2Router.json').abi;
const wethABI = require('../../artifacts/contracts/interfaces/IWETH.sol/IWETH.json').abi;
const oracleABI = require('../../artifacts/contracts/interfaces/IOracle.sol/IOracle.json').abi;

export const UNISWAP_FACTORY_ADDRESS = '0x5c69bee701ef814a2b6a3edd4b1652cb9cc5aa6f';
export const SUSHISWAP_FACTORY_ADDRESS = '0xC0AEe478e3658e2610c5F7A4A2E1777cE9e4f2Ac';
export const UNISWAP_ROUTER_ADDRESS = '0x7a250d5630b4cf539739df2c5dacb4c659f2488d'
export const SUSHISWAP_ROUTER_ADDRESS = '0xd9e1cE17f2641f24aE83637ab66a2cca9C378B9F'
export const WETH_ADDRESS = '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2';
export const ORACLE_ADDRESS = '0xFa5a44D3Ba93D666Bf29C8804a36e725ecAc659A';
export const TREASURY_ADDRESS = '0x78a3eF33cF033381FEB43ba4212f2Af5A5A0a2EA';

const [wallet] = waffle.provider.getWallets()

export const UNI_FACTORY = new Contract('0x5C69bEe701ef814a2B6a3EDD4B1652CB9cc5aA6f', factoryABI, wallet) as IUniswapV2Factory
export const SUSHI_FACTORY = new Contract('0xC0AEe478e3658e2610c5F7A4A2E1777cE9e4f2Ac', factoryABI, wallet) as IUniswapV2Factory
export const WETH = new Contract(WETH_ADDRESS, wethABI, wallet) as IWETH;
export const UNI_ROUTER = new Contract(UNISWAP_ROUTER_ADDRESS, routerABI, wallet) as IUniswapV2Router
export const SUSHI_ROUTER = new Contract(SUSHISWAP_ROUTER_ADDRESS, routerABI, wallet) as IUniswapV2Router
export const ORACLE = new Contract(ORACLE_ADDRESS, oracleABI, wallet) as IOracle

export function getBigNumber(n: number, decimals = 18) {
  return BigNumber.from(10).pow(decimals).mul(n);
}

export async function getContractBase<C extends Contract>(address: string, name: string): Promise<C> {
  let contract = await ethers.getContractAt(name, address);
  return contract as C;
}

//#region Fork utils

export async function impersonate(address: string) {
  await network.provider.request({
    method: "hardhat_impersonateAccount",
    params: [address]
  });
  return ethers.provider.getSigner(address);
}

export async function stopImpersonating(address: string) {
  await network.provider.request({
    method: "hardhat_stopImpersonatingAccount",
    params: [address]
  });
}

export async function resetFork() {
  await network.provider.request({
    method: 'hardhat_reset',
    params: [{
      forking: {
        jsonRpcUrl: `https://eth-mainnet.alchemyapi.io/v2/`,
        blockNumber: 12313413
      }
    }]
  })
}
//#endregion
export async function mintWeth(to: string = wallet.address, amount: BigNumber = getBigNumber(1)) {
  await sendEtherTo(wallet.address, amount)
  await WETH.deposit({ value: amount })
  if (to !== wallet.address) {
    await WETH.transfer(to, amount)
  }
}


//#region Impersonation utils
export async function withSigner(address: string, fn: (signer: JsonRpcSigner) => Promise<void>) {
  const signer = await impersonate(address);
  await fn(signer);
  await stopImpersonating(address);
}

export const sendEtherTo = (address: string, amount: BigNumber = BigNumber.from(10).pow(20)) => withSigner(WETH_ADDRESS, async (signer) => {
  const factory = await ethers.getContractFactory('SendEth');
  const tx = await factory.getDeployTransaction(address);
  await signer.sendTransaction({ data: tx.data, value: amount });
});

export async function sendTokenTo(erc20: string, to: string, amount: BigNumber) {
  if (erc20.toLowerCase() === WETH_ADDRESS.toLowerCase()) {
    await sendEtherTo(to, amount)
    await withSigner(to, async (signer) => {
      await WETH.connect(signer).deposit({ value: amount });
    })
  } else {
    const pair = computeUniPairAddress(erc20, WETH_ADDRESS);
    const token = (await ethers.getContractAt('IERC20', erc20)) as IERC20;
    await sendEtherTo(pair);
    await withSigner(pair, async (signer) => {
      await token.connect(signer).transfer(to, amount);
    });
  }
}

export async function getContract<C extends Contract>(address: string, name: string, signer?: string | JsonRpcSigner): Promise<C> {
  let contract = await getContractBase(address, name);
  if (signer) {
    const _signer = typeof signer === 'string' ? await impersonate(signer) : signer;
    contract = contract.connect(_signer);
  }
  return contract as C;
}
//#endregion

/* Other Utils */

export async function deploy(bytecode: string): Promise<string> {
  const [signer] = await ethers.getSigners();
  const tx = await signer.sendTransaction({ data: bytecode });
  const { contractAddress } = await tx.wait();
  return contractAddress;
}

export async function deployContract<C extends Contract>(name: string, ...args: any[]): Promise<C> {
  const f = await ethers.getContractFactory(name);
  const c = await f.deploy(...args);
  return c as C;
}

//#region Uniswap
export function sortTokens(tokenA: string, tokenB: string): string[] {
  return tokenA.toLowerCase() < tokenB.toLowerCase()
    ? [tokenA, tokenB]
    : [tokenB, tokenA];
}

export function computeUniPairAddress(
  tokenA: string,
  tokenB: string
): string {
  const initCodeHash =
    "0x96e8ac4277198ff8b6f785478aa9a39f403cb768dd02cbee326c3e7da348845f";
  const [token0, token1] = sortTokens(tokenA, tokenB);
  const salt = keccak256(
    Buffer.concat([
      Buffer.from(token0.slice(2).padStart(40, "0"), "hex"),
      Buffer.from(token1.slice(2).padStart(40, "0"), "hex"),
    ])
  );
  return getCreate2Address(UNISWAP_FACTORY_ADDRESS, salt, initCodeHash);
}

export function computeSushiPairAddress(
  tokenA: string,
  tokenB: string
): string {
  const initCodeHash =
    "0xe18a34eb0e04b04f7a0ac29a6e80748dca96319b42c54d679cb821dca90c6303";
  const [token0, token1] = sortTokens(tokenA, tokenB);
  const salt = keccak256(
    Buffer.concat([
      Buffer.from(token0.slice(2).padStart(40, "0"), "hex"),
      Buffer.from(token1.slice(2).padStart(40, "0"), "hex"),
    ])
  );
  return getCreate2Address(SUSHISWAP_FACTORY_ADDRESS, salt, initCodeHash);
}
//#endregion Uniswap