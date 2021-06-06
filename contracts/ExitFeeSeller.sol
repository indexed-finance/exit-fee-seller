// SPDX-License-Identifier: MIT
pragma solidity >=0.7.0;
pragma abicoder v2;

import "@openzeppelin/contracts/access/Ownable.sol";
import "./libraries/TransferHelper.sol";
import "./libraries/LowGasSafeMath.sol";
import "./libraries/UniswapV2Library.sol";
import "./interfaces/IBancorNetwork.sol";
import "./interfaces/IContractRegistry.sol";
import "./interfaces/IWETH.sol";


contract ExitFeeSeller is Ownable() {
  using TransferHelper for address;
  using LowGasSafeMath for uint256;

/* ==========  Constants  ========== */

  uint256 public constant minTwapAge = 30 minutes;
  uint256 public constant maxTwapAge = 2 days;
  address public constant bancorEthAddress = 0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE;
  bytes32 public constant bancorName = 0x42616e636f724e6574776f726b00000000000000000000000000000000000000; // "BancorNetwork"
  IOracle public constant oracle = IOracle(0xFa5a44D3Ba93D666Bf29C8804a36e725ecAc659A);
  IContractRegistry public constant bancorRegistry = IContractRegistry(0x52Ae12ABe5D8BD778BD5397F99cA900624CfADD4);
  address public constant uniswapFactory = 0x5C69bEe701ef814a2B6a3EDD4B1652CB9cc5aA6f;
  address public constant weth = 0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2;
  address public constant ndx = 0x86772b1409b61c639EaAc9Ba0AcfBb6E238e5F83;
  IDNDX public immutable dndx;

/* ==========  Storage  ========== */

  uint16 public twapDiscountBips = 500; // 5%

  struct UniswapParams {
    address tokenIn;
    uint256 amountIn;
    address pair;
    bool zeroForOne;
    uint256 amountOut;
  }

  struct BancorParams {
    IBancorNetwork bancor;
    address[] path;
    uint256 amountOut;
  }

/* ==========  Constructor  ========== */

  constructor(address _dndx) {
    dndx = IDNDX(_dndx);
    ndx.safeApprove(_dndx, type(uint256).max);
  }

  function takeTokensFromOwner(address[] memory tokens) external {
    uint256 len = tokens.length;
    address _owner = owner();
    for (uint256 i = 0; i < len; i++) {
      address token = tokens[i];
      uint256 ownerBalance = IERC20(token).balanceOf(_owner);
      if (ownerBalance > 0) {
        token.safeTransferFrom(_owner, address(this), ownerBalance);
      }
    }
  }

/* ==========  Owner Controls  ========== */

  function setTWAPDiscountBips(uint16 _twapDiscountBips) external onlyOwner {
    require(_twapDiscountBips < 1000, "Can not set discount over 10%");
    twapDiscountBips = _twapDiscountBips;
  }

/* ==========  Queries  ========== */

  function getBancor() public view returns (IBancorNetwork) {
    return IBancorNetwork(bancorRegistry.addressOf(bancorName));
  }

  function getBancorNDXForETHParams(uint256 amountIn)
    public
    view
    returns (BancorParams memory params)
  {
    IBancorNetwork bancor = getBancor();
    params.bancor = bancor;
    params.path = bancor.conversionPath(bancorEthAddress, ndx);
    params.amountOut = bancor.rateByPath(params.path, amountIn);
  }

  function getUniswapParams(
    address tokenIn, 
    address tokenOut, 
    uint256 amountIn
  ) public view returns (UniswapParams memory params) {
    (address token0, address token1) = UniswapV2Library.sortTokens(tokenIn, tokenOut);
    address pair = UniswapV2Library.calculatePair(uniswapFactory, token0, token1);
    bool zeroForOne = tokenIn == token0;
    (uint256 reserve0, uint256 reserve1, ) = IUniswapV2Pair(pair).getReserves();
    (uint256 reserveIn, uint256 reserveOut) = tokenIn == token0
      ? (reserve0, reserve1)
      : (reserve1, reserve0);
    uint256 amountOut = UniswapV2Library.getAmountOut(amountIn, reserveIn, reserveOut);
    params = UniswapParams(tokenIn, amountIn, pair, zeroForOne, amountOut);
  }

  function getMinimumAmountOut(address tokenIn, address tokenOut, uint256 amountIn) public view returns (uint256) {
    uint256 averageAmountOut = (tokenIn == weth)
      ? oracle.computeAverageTokensForEth(tokenOut, amountIn, minTwapAge, maxTwapAge)
      : oracle.computeAverageEthForTokens(tokenIn, amountIn, minTwapAge, maxTwapAge);

    return averageAmountOut.sub(averageAmountOut.mul(twapDiscountBips) / uint256(10000));
  }

/* ==========  Swaps  ========== */

  function execute(UniswapParams memory params) internal {
    params.tokenIn.safeTransfer(params.pair, params.amountIn);
    (uint256 amount0Out, uint256 amount1Out) = params.zeroForOne ? (uint256(0), params.amountOut) : (params.amountOut, uint256(0));
    IUniswapV2Pair(params.pair).swap(amount0Out, amount1Out, address(this), new bytes(0));
  }

  function sellTokenForETH(address token) external {
    require(token != ndx, "Can not sell NDX");
    require(token != weth, "Can not sell WETH");
    uint256 amountIn = IERC20(token).balanceOf(address(this));
    uint256 minimumAmountOut = getMinimumAmountOut(token, weth, amountIn);
    UniswapParams memory params = getUniswapParams(token, weth, amountIn);
    require(params.amountOut >= minimumAmountOut, "Insufficient output");
    execute(params);
  }

  function buyNDX() external {
    uint256 wethBalance = IERC20(weth).balanceOf(address(this));
    uint256 ethBalance = address(this).balance;
    uint256 amountIn = wethBalance + ethBalance;
    UniswapParams memory uniParams = getUniswapParams(weth, ndx, amountIn);
    BancorParams memory bancorParams = getBancorNDXForETHParams(amountIn);
    uint256 minimumAmountOut = getMinimumAmountOut(weth, ndx, amountIn);
    // >= because uniswap costs less gas
    if (uniParams.amountOut >= bancorParams.amountOut) {
      require(uniParams.amountOut >= minimumAmountOut, "Insufficient output");
      IWETH(weth).deposit{value: ethBalance}();
      execute(uniParams);
      dndx.distribute(uniParams.amountOut);
    } else {
      require(bancorParams.amountOut >= minimumAmountOut, "Insufficient output");
      IWETH(weth).withdraw(wethBalance);
      bancorParams.bancor.convertByPath{value: amountIn}(
        bancorParams.path,
        amountIn,
        bancorParams.amountOut,
        address(0),
        address(0),
        0
      );
      dndx.distribute(uniParams.amountOut);
    }
  }
}


interface IDNDX {
  function distribute(uint256 amount) external;
}


interface IOracle {
  struct PriceObservation {
    uint32 timestamp;
    uint224 priceCumulativeLast;
    uint224 ethPriceCumulativeLast;
  }

  function updatePrice(address token) external returns (bool);

  function updatePrices(address[] calldata tokens) external returns (bool[] memory);

  function getPriceObservationsInRange(
    address token,
    uint256 timeFrom,
    uint256 timeTo
  ) external view returns (PriceObservation[] memory prices);

  function computeAverageEthForTokens(
    address token,
    uint256 tokenAmount,
    uint256 minTimeElapsed,
    uint256 maxTimeElapsed
  ) external view returns (uint144);

  function computeAverageTokensForEth(
    address token,
    uint256 wethAmount,
    uint256 minTimeElapsed,
    uint256 maxTimeElapsed
  ) external view returns (uint144);
}