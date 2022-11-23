// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

interface IWETH {
    function deposit() external payable;
    function transfer(address to, uint value) external returns (bool);
    function withdraw(uint) external;
}

contract Reentrant {

    address constant WETH = 0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2;

    receive() external payable {}

    function deposit() public {
        uint256 before = address(this).balance;
        IWETH(WETH).deposit{ value: 12345 }();
        require(before - address(this).balance == 12345);
    }

    function withdraw() public {
        uint256 before = address(this).balance;
        IWETH(WETH).withdraw(12345);
        require(address(this).balance - before == 12345);
    }
}
