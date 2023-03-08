// SPDX-License-Identifier: MIT
pragma solidity ^0.8.16;

contract DummyConstructor {
    uint256 private someStorageSlot;

    constructor() {
        someStorageSlot = type(uint256).max;
    }

    function read() public view returns (uint256) {
        return someStorageSlot;
    }
}
