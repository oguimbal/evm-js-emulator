// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

contract Dummy {
    uint256 private someStorageSlot;

    function assign(uint256 value) public {
        someStorageSlot = value;
    }

    function read() public view returns (uint256) {
        return someStorageSlot;
    }
}
