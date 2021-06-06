import { ethers, waffle } from 'hardhat';
import { expect } from "chai";
import { ExitFeeSeller, IERC20, IOracle, TestDNDX, IUniswapV2Router } from '../typechain';
import { advanceTimeAndBlock, deployContract, getContract, impersonate, latest, sendEtherTo, stopImpersonating } from './shared'
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
  const [wallet] = waffle.provider.getWallets();
  let seller: ExitFeeSeller;
  let dndx: TestDNDX;
  let oracle: IOracle;
  let router: IUniswapV2Router

  async function getBalance(token: string, account: string) {
    const erc20: IERC20 = await getContract(token, 'IERC20');
    return erc20.balanceOf(account);
  }

  async function updatePrice(token: string) {
    await oracle.updatePrice(token);
    await advanceTimeAndBlock(7200);
    await router.swapExactETHForTokens(0, ['0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2', token], wallet.address, (await latest()) + 60, { value: BigNumber.from(10).pow(18) });
  }

  before('Deploy ExitFeeSeller', async () => {
    await sendEtherTo(wallet.address, BigNumber.from(10).pow(20));
    await sendEtherTo(timelock, BigNumber.from(10).pow(20));
    dndx = await deployContract('TestDNDX');
    seller = await deployContract('ExitFeeSeller', dndx.address);
    const signer = await impersonate(timelock);
    for (let token of indexTokens) {
      const erc20: IERC20 = await getContract(token, 'IERC20', signer);
      await erc20.approve(seller.address, constants.MaxUint256);
    }
    await stopImpersonating(timelock)
    await seller.transferOwnership(timelock);
    oracle = await getContract(await seller.oracle(), 'IOracle');
    router = await getContract('0x7a250d5630b4cf539739df2c5dacb4c659f2488d', 'IUniswapV2Router')
  })

  describe('takeTokensFromOwner', () => {
    it("Should transfer tokens from owner", async () => {
      const balances: BigNumber[] = [];
      for (let token of indexTokens) {
        const erc20: IERC20 = await getContract(token, 'IERC20');
        balances.push(await erc20.balanceOf(timelock));
      }
      await seller.takeTokensFromOwner(indexTokens);
      for (let i = 0; i < indexTokens.length; i++) {
        const token = indexTokens[i];
        const oldBalance = balances[i];
        const erc20: IERC20 = await getContract(token, 'IERC20');
        expect(await erc20.balanceOf(timelock)).to.eq(0);
        expect(await erc20.balanceOf(seller.address)).to.eq(oldBalance);
      }
    });
  });

  describe('getBancorNDXForETHParams()', () => {
    it('Should return params for ETH-NDX swap on Bancor', async () => {
      // Specific to the forked block #
      const params = await seller.getBancorNDXForETHParams(BigNumber.from(10).pow(18));
      expect(params.path).to.deep.eq([
        '0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE',
        '0xb1CD6e4153B2a390Cf00A6556b0fC1458C4A5533',
        '0x1F573D6Fb3F13d689FF844B4cE37794d79a7FF1C',
        '0xdc2e3142c5803e040FEb2d2E3c09c865FC5e3d0C',
        '0x86772b1409b61c639EaAc9Ba0AcfBb6E238e5F83'
      ]);
      expect(params.bancor).to.eq('0x2F9EC37d6CcFFf1caB21733BdaDEdE11c823cCB0');
      expect(params.amountOut).to.eq('0x250189f15e1e7612e5');
    })
  })
  
  describe('sellTokenForETH()', () => {
    it('Should revert if token is ndx', async () => {
      await expect(seller.sellTokenForETH('0x86772b1409b61c639EaAc9Ba0AcfBb6E238e5F83')).to.be.revertedWith('Can not sell NDX')
    })

    it('Should revert if token is weth', async () => {
      await expect(seller.sellTokenForETH('0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2')).to.be.revertedWith('Can not sell WETH')
    })

    it('Should revert if no price available on oracle', async () => {
      await expect(seller.sellTokenForETH(indexTokens[0])).to.be.revertedWith('IndexedUniswapV2Oracle::_getTokenPrice: No price found in provided range.')
    })

    it('Should sell tokens if output is >= TWAP - discount', async () => {
      for (const token of indexTokens) {
        await updatePrice(token);
        await seller.sellTokenForETH(token);
      }
      const weth: IERC20 = await getContract('0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2', 'IERC20')
      console.log('Received', formatEther(await weth.balanceOf(seller.address)), 'ETH');
    })
  })

  describe('buyNDX()', () => {
    it('Should revert if no price available on oracle', async () => {
      await expect(seller.buyNDX()).to.be.revertedWith('IndexedUniswapV2Oracle::_getEthPrice: No price found in provided range.')
    })

    it('Should buy NDX', async () => {
      await updatePrice('0x86772b1409b61c639EaAc9Ba0AcfBb6E238e5F83')
      await seller.buyNDX();
      console.log(formatEther(await getBalance('0x86772b1409b61c639EaAc9Ba0AcfBb6E238e5F83', seller.address)))
      console.log(formatEther(await getBalance('0x86772b1409b61c639EaAc9Ba0AcfBb6E238e5F83', dndx.address)))
    })
  })
});