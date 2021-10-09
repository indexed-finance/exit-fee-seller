// SPDX-License-Identifier: MIT
pragma solidity >=0.7.0;

import "@openzeppelin/contracts/token/ERC20/ERC20.sol";


contract TestERC20 is ERC20("Test Token", "TEST") {
  function mint(address to, uint256 amount) external {
    _mint(to, amount);
  }
}