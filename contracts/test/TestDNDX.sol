// SPDX-License-Identifier: MIT
pragma solidity >=0.7.0;

import "../libraries/TransferHelper.sol";



contract TestDNDX {
  using TransferHelper for address;

  address public constant ndx = 0x86772b1409b61c639EaAc9Ba0AcfBb6E238e5F83;

  function distribute(uint256 amount) external {
    ndx.safeTransferFrom(msg.sender, address(this), amount);
  }
}