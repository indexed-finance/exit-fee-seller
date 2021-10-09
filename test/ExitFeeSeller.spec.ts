import { ethers, waffle } from 'hardhat';
import { expect } from "chai";
import { ExitFeeSeller, IDNDX, IERC20, IOracle, IUniswapV2Router, TestERC20 } from '../typechain';
import { advanceTimeAndBlock, deployContract, getContract, impersonate, latest, sendEtherTo, stopImpersonating, EthPair, getBigNumber, WETH, createTokenWithEthPairs, duration, ORACLE, WETH_ADDRESS, mintWeth, TREASURY_ADDRESS } from './shared'
import { BigNumber, constants } from 'ethers';
import { formatEther, parseEther } from '@ethersproject/units';

const indexTokens = [
  '0x126c121f99e1e211df2e5f8de2d96fa36647c855',
  '0xfa6de2697d59e88ed7fc4dfe5a33dac43565ea41',
  '0x17ac188e09a7890a1844e5e65471fe8b0ccfadf3',
  '0x68bb81b3f67f7aab5fd1390ecb0b8e1a806f2465',
  '0xd3deff001ef67e39212f4973b617c2e684fa436c',
  '0xabafa52d3d5a2c18a4c1ae24480d22b831fc0413',
  '0xd6cb2adf47655b1babddc214d79257348cbc39a7',
];
const timelock = '0x78a3eF33cF033381FEB43ba4212f2Af5A5A0a2EA';

describe("ExitFeeSeller", function() {
  const [wallet, wallet1] = waffle.provider.getWallets();
  let seller: ExitFeeSeller;
  let dndx: IDNDX;
  let token: TestERC20
  let uni: EthPair, sushi: EthPair;
  let updatePrice: () => Promise<void>;

  async function getBalance(token: string, account: string) {
    const erc20: IERC20 = await getContract(token, 'IERC20');
    return erc20.balanceOf(account);
  }

  beforeEach('Deploy ExitFeeSeller', async () => {
    dndx = await getContract('0x262cd9ADCE436B6827C01291B84f1871FB8b95A3', 'IDNDX');
    ({token, uni, sushi, updatePrice} = await createTokenWithEthPairs()) 
    seller = await deployContract('ExitFeeSeller');
  })

  describe('takeTokensFromOwner()', () => {
    it('Should transfer owner balance of each token to the seller', async () => {
      await token.approve(seller.address, getBigNumber(1))
      await token.mint(wallet.address, getBigNumber(1))
      await expect(seller.takeTokensFromOwner([token.address]))
        .to.emit(token, 'Transfer')
        .withArgs(wallet.address, seller.address, getBigNumber(1))
    })

    it('Should not do anything if owner has no balance', async () => {
      await expect(seller.takeTokensFromOwner([token.address]))
        .to.not.be.reverted
    })
  })

  describe('setTWAPDiscountBips()', () => {
    it('Should revert if not called by owner', async () => {
      await expect(seller.connect(wallet1).setTWAPDiscountBips(1))
        .to.be.revertedWith('Ownable: caller is not the owner')
    })

    it('Should revert if discount over 10%', async () => {
      await expect(seller.setTWAPDiscountBips(1001))
        .to.be.revertedWith('Can not set discount >= 10%')
    })

    it('Should set discount bips', async () => {
      await seller.setTWAPDiscountBips(1000)
      expect(await seller.twapDiscountBips()).to.eq(1000)
    })
  })

  describe('setEthToTreasuryBips()', () => {
    it('Should revert if not called by owner', async () => {
      await expect(seller.connect(wallet1).setEthToTreasuryBips(1))
        .to.be.revertedWith('Ownable: caller is not the owner')
    })

    it('Should revert if over 100%', async () => {
      await expect(seller.setEthToTreasuryBips(10001))
        .to.be.revertedWith('Can not set bips over 100%')
    })

    it('Should set discount bips', async () => {
      await seller.setEthToTreasuryBips(5000)
      expect(await seller.ethToTreasuryBips()).to.eq(5000)
    })
  })

  describe('returnTokens()', () => {
    it('Should revert if not called by owner', async () => {
      await expect(seller.connect(wallet1).returnTokens([token.address]))
        .to.be.revertedWith('Ownable: caller is not the owner')
    })

    it('Should do nothing if account has no balance', async () => {
      await expect(seller.returnTokens([ token.address, constants.AddressZero ]))
        .to.not.be.reverted
        .to.changeEtherBalances
    })

    it('Should transfer ETH balance if address is zero', async () => {
      await sendEtherTo(seller.address, getBigNumber(1))
      await expect(await seller.returnTokens([constants.AddressZero]))
        .to.changeEtherBalances(
          [{ getAddress: () => seller.address, provider: wallet.provider }, wallet],
          [getBigNumber(-1), getBigNumber(1)]
        )
    })

    it('Should transfer token balance if address is not zero', async () => {
      await token.mint(seller.address, getBigNumber(1))
      await expect(seller.returnTokens([token.address]))
        .to.emit(token, 'Transfer')
        .withArgs(seller.address, wallet.address, getBigNumber(1))
    })
  })

  describe('getMinimumAmountOut()', () => {
    it('Should revert if oracle has no observations', async () => {
      await expect(seller.getMinimumAmountOut(token.address, getBigNumber(1)))
        .to.be.revertedWith('IndexedUniswapV2Oracle::_getTokenPrice: No price found in provided range.')
    })

    it('Should return average value of token in ETH', async () => {
      await updatePrice()
      await advanceTimeAndBlock(duration.hours(3))
      const average = await ORACLE.computeAverageEthForTokens(token.address, getBigNumber(1), duration.minutes(30), duration.days(2))
      const minimum = average.sub(average.mul(500).div(10000))
      expect(await seller.getMinimumAmountOut(token.address, getBigNumber(1)))
        .to.eq(minimum)
    })
  })

  describe('getBestPair()', () => {
    it('Should return UNI if prices are the same', async () => {
      const expectAmountOut = uni.getEthOut(getBigNumber(1))
      const { pair, amountOut } = await seller.getBestPair(token.address, getBigNumber(1))
      expect(pair).to.eq(uni.pair.address)
      expect(amountOut).to.eq(expectAmountOut)
    })

    it('Should return SUSHI if price is better', async () => {
      await uni.sellToken()
      const expectAmountOut = sushi.getEthOut(getBigNumber(1))
      const { pair, amountOut } = await seller.getBestPair(token.address, getBigNumber(1))
      expect(pair).to.eq(sushi.pair.address)
      expect(amountOut).to.eq(expectAmountOut)
    })

    it('Should not revert if SUSHI has no reserves', async () => {
      ({ uni, sushi, token } = await createTokenWithEthPairs(true, false))
      const expectAmountOut = uni.getEthOut(getBigNumber(1))
      const { pair, amountOut } = await seller.getBestPair(token.address, getBigNumber(1))
      expect(pair).to.eq(uni.pair.address)
      expect(amountOut).to.eq(expectAmountOut)
    })
  })

  describe('sellTokenForETH(address)', () => {
    it('Should revert if token is weth', async () => {
      await expect(seller['sellTokenForETH(address)'](WETH_ADDRESS))
        .to.be.revertedWith('Can not sell WETH')
    })

    it('Should revert if output is lower than minimum', async () => {
      await token.mint(seller.address, getBigNumber(1))
      await updatePrice()
      await advanceTimeAndBlock(duration.hours(3))
      await uni.sellToken(wallet.address, getBigNumber(5))
      await sushi.sellToken(wallet.address, getBigNumber(5))
      await expect(seller['sellTokenForETH(address)'](token.address))
        .to.be.revertedWith('Insufficient output')
    })

    it('Should swap with UNI if price is the same', async () => {
      await token.mint(seller.address, getBigNumber(1, 17))
      await updatePrice()
      await advanceTimeAndBlock(duration.hours(3))
      const amountOut = uni.getEthOut(getBigNumber(1, 17))
      await expect(seller['sellTokenForETH(address)'](token.address))
        .to.emit(token, 'Transfer')
        .withArgs(seller.address, uni.pair.address, getBigNumber(1, 17))
        .to.emit(WETH, 'Transfer')
        .withArgs(uni.pair.address, seller.address, amountOut)
    })

    it('Should swap with Sushi if price is better', async () => {
      await token.mint(seller.address, getBigNumber(1, 17))
      await updatePrice()
      await advanceTimeAndBlock(duration.hours(3))
      await uni.sellToken()
      const amountOut = sushi.getEthOut(getBigNumber(1, 17))
      await expect(seller['sellTokenForETH(address)'](token.address))
        .to.emit(token, 'Transfer')
        .withArgs(seller.address, sushi.pair.address, getBigNumber(1, 17))
        .to.emit(WETH, 'Transfer')
        .withArgs(sushi.pair.address, seller.address, amountOut)
    })
  })

  describe('sellTokenForETH(address,uint256)', () => {
    it('Should revert if token is weth', async () => {
      await expect(seller['sellTokenForETH(address,uint256)'](WETH_ADDRESS, 0))
        .to.be.revertedWith('Can not sell WETH')
    })

    it('Should revert if output is lower than minimum', async () => {
      await token.mint(seller.address, getBigNumber(1))
      await updatePrice()
      await advanceTimeAndBlock(duration.hours(3))
      await uni.sellToken(wallet.address, getBigNumber(5))
      await sushi.sellToken(wallet.address, getBigNumber(5))
      await expect(seller['sellTokenForETH(address,uint256)'](token.address, getBigNumber(1)))
        .to.be.revertedWith('Insufficient output')
    })

    it('Should swap with UNI if price is the same', async () => {
      await token.mint(seller.address, getBigNumber(1, 17))
      await updatePrice()
      await advanceTimeAndBlock(duration.hours(3))
      const amountOut = uni.getEthOut(getBigNumber(1, 17))
      await expect(seller['sellTokenForETH(address,uint256)'](token.address, getBigNumber(1, 17)))
        .to.emit(token, 'Transfer')
        .withArgs(seller.address, uni.pair.address, getBigNumber(1, 17))
        .to.emit(WETH, 'Transfer')
        .withArgs(uni.pair.address, seller.address, amountOut)
    })

    it('Should swap with Sushi if price is better', async () => {
      await token.mint(seller.address, getBigNumber(1, 17))
      await updatePrice()
      await advanceTimeAndBlock(duration.hours(3))
      await uni.sellToken()
      const amountOut = sushi.getEthOut(getBigNumber(1, 17))
      await expect(seller['sellTokenForETH(address,uint256)'](token.address, getBigNumber(1, 17)))
        .to.emit(token, 'Transfer')
        .withArgs(seller.address, sushi.pair.address, getBigNumber(1, 17))
        .to.emit(WETH, 'Transfer')
        .withArgs(sushi.pair.address, seller.address, amountOut)
    })
  })

  describe('distributeETH()', () => {
    it('Should wrap any eth held', async () => {
      await sendEtherTo(seller.address, getBigNumber(1))
      await expect(seller.distributeETH())
        .to.emit(WETH, 'Deposit')
        .withArgs(seller.address, getBigNumber(1))
    })

    it('Should not attempt to wrap if no eth held', async () => {
      await expect(seller.distributeETH()).to.not.be.reverted
    })

    it('Should transfer to treasury and distribute the rest', async () => {
      await sendEtherTo(seller.address, getBigNumber(1))
      await mintWeth(seller.address, getBigNumber(1))
      await expect(seller.distributeETH())
        .to.emit(WETH, 'Deposit')
        .withArgs(seller.address, getBigNumber(1))
        .to.emit(WETH, 'Transfer')
        .withArgs(seller.address, TREASURY_ADDRESS, getBigNumber(8, 17))
        .to.emit(WETH, 'Transfer')
        .withArgs(seller.address, dndx.address, getBigNumber(12, 17))
        .to.emit(dndx, 'DividendsDistributed')
        .withArgs(seller.address, getBigNumber(12, 17))
    })
  })
});