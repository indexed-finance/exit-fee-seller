import { BigNumber, constants } from 'ethers';
import { waffle, ethers } from 'hardhat';
import { IUniswapV2Pair, IUniswapV2Router, TestERC20 } from '../../typechain';
import { latest } from './time';

import {
  UNI_FACTORY,
  SUSHI_FACTORY,
  WETH,
  deployContract,
  sendEtherTo,
  computeUniPairAddress,
  computeSushiPairAddress,
  getBigNumber,
  UNISWAP_ROUTER_ADDRESS,
  SUSHISWAP_ROUTER_ADDRESS,
  WETH_ADDRESS,
  getContract,
  UNI_ROUTER,
  SUSHI_ROUTER,
  ORACLE,
  mintWeth
} from './utils';

const [wallet] = waffle.provider.getWallets();

export class EthPair {
  public reserveToken: BigNumber = BigNumber.from(0)
  public reserveEth: BigNumber = BigNumber.from(0)
  constructor(
    public pair: IUniswapV2Pair,
    public token: TestERC20,
    public router: IUniswapV2Router
  ) {}

  getEthOut(amountIn: BigNumber) {
    const amountInWithFee = amountIn.mul(997);
    const numerator = amountInWithFee.mul(this.reserveEth);
    const denominator = this.reserveToken.mul(1000).add(amountInWithFee);
    return numerator.div(denominator);
  }

  getTokenOut(amountIn: BigNumber) {
    const amountInWithFee = amountIn.mul(997);
    const numerator = amountInWithFee.mul(this.reserveToken);
    const denominator = this.reserveEth.mul(1000).add(amountInWithFee);
    return numerator.div(denominator);
  }

  async addLiquidity(
    to: string = wallet.address,
    tokenAmount: BigNumber = getBigNumber(10),
    ethAmount: BigNumber = getBigNumber(10)
  ) {
    await mintWeth(wallet.address, ethAmount)
    await WETH.transfer(this.pair.address, ethAmount)
    await this.token.mint(this.pair.address, tokenAmount)
    await this.pair.mint(to)
    this.reserveToken = this.reserveToken.add(tokenAmount)
    this.reserveEth = this.reserveEth.add(ethAmount)
  }

  async buyToken(to: string = wallet.address, ethAmount: BigNumber = getBigNumber(1, 17)) {
    await sendEtherTo(wallet.address)
    await this.router.swapExactETHForTokens(
      0,
      [WETH_ADDRESS, this.token.address],
      to,
      await latest() + 1000,
      { value: ethAmount }
    )
    const tokenOut = this.getTokenOut(ethAmount)
    this.reserveEth = this.reserveEth.add(ethAmount)
    this.reserveToken = this.reserveToken.sub(tokenOut)
  }

  async sellToken(to: string = wallet.address, tokenAmount: BigNumber = getBigNumber(1, 17)) {
    await this.token.mint(wallet.address, tokenAmount)
    await this.router.swapExactTokensForETH(
      tokenAmount,
      0,
      [this.token.address, WETH_ADDRESS],
      to,
      await latest() + 1000
    )
    const ethOut = this.getEthOut(tokenAmount)
    this.reserveEth = this.reserveEth.sub(ethOut)
    this.reserveToken = this.reserveToken.add(tokenAmount)
  }
}

async function createUniPair(token: TestERC20): Promise<EthPair> {
  const uniAddress = computeUniPairAddress(token.address, WETH_ADDRESS)
  await UNI_FACTORY.createPair(token.address, WETH_ADDRESS)
  const uni = new EthPair(
    await getContract<IUniswapV2Pair>(uniAddress, 'IUniswapV2Pair'),
    token,
    UNI_ROUTER
  )
  await WETH.approve(UNISWAP_ROUTER_ADDRESS, constants.MaxUint256)
  await token.approve(UNISWAP_ROUTER_ADDRESS, constants.MaxUint256)
  return uni
}

async function createSushiPair(token: TestERC20): Promise<EthPair> {
  const sushiAddress = computeSushiPairAddress(token.address, WETH_ADDRESS)
  await SUSHI_FACTORY.createPair(token.address, WETH_ADDRESS)
  const sushi = new EthPair(
    await getContract<IUniswapV2Pair>(sushiAddress, 'IUniswapV2Pair'),
    token,
    SUSHI_ROUTER
  )
  await WETH.approve(SUSHISWAP_ROUTER_ADDRESS, constants.MaxUint256)
  await token.approve(SUSHISWAP_ROUTER_ADDRESS, constants.MaxUint256)
  return sushi
}

export async function createPairs(token: TestERC20, withUni = true, withSushi = true): Promise<{ uni: EthPair, sushi: EthPair }> {
  const uni = await createUniPair(token)
  const sushi = await createSushiPair(token)
  if (withUni) await uni.addLiquidity()
  if (withSushi) await sushi.addLiquidity()
  return { uni, sushi }
}

export async function createTokenWithEthPairs(withUni = true, withSushi = true) {
  const token = await deployContract('TestERC20') as TestERC20;
  const { uni, sushi } = await createPairs(token, withUni, withSushi)
  const updatePrice = async () => {
    await uni.buyToken()
    await sushi.buyToken()
    await ORACLE.updatePrice(token.address)
  }
  return { token, uni, sushi, updatePrice }
}