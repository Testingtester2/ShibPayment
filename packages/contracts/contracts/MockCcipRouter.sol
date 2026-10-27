// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

interface IERC20Like {
    function transferFrom(address from, address to, uint256 value) external returns (bool);
}

/// @dev Test-only stand-in for a Chainlink CCIP router: same getFee/ccipSend
/// signatures, a flat fee per token, and it keeps the tokens it is sent.
/// Not deployed anywhere.
contract MockCcipRouter {
    struct EVMTokenAmount { address token; uint256 amount; }
    struct EVM2AnyMessage { bytes receiver; bytes data; EVMTokenAmount[] tokenAmounts; address feeToken; bytes extraArgs; }

    event Sent(uint64 destinationChainSelector, bytes receiver, address token, uint256 amount, uint256 fee, bytes extraArgs);

    uint64 public constant ETHEREUM = 5009297550715157269;
    uint256 public constant FEE_PER_TOKEN = 0.001 ether;
    /// extraArgs starting with this tag are refused, to test the fallback.
    bytes4 public refusedTag;

    function setRefusedTag(bytes4 tag) external { refusedTag = tag; }

    function getFee(uint64 destinationChainSelector, EVM2AnyMessage calldata message) public view returns (uint256) {
        require(destinationChainSelector == ETHEREUM, "destination");
        require(message.feeToken == address(0), "fee token");
        if (refusedTag != bytes4(0) && message.extraArgs.length >= 4 && bytes4(message.extraArgs[:4]) == refusedTag) revert("extraArgs");
        return FEE_PER_TOKEN * message.tokenAmounts.length;
    }

    function ccipSend(uint64 destinationChainSelector, EVM2AnyMessage calldata message) external payable returns (bytes32) {
        uint256 fee = getFee(destinationChainSelector, message);
        require(msg.value >= fee, "fee");
        for (uint256 i = 0; i < message.tokenAmounts.length; i++) {
            EVMTokenAmount calldata t = message.tokenAmounts[i];
            require(IERC20Like(t.token).transferFrom(msg.sender, address(this), t.amount), "transfer");
            emit Sent(destinationChainSelector, message.receiver, t.token, t.amount, msg.value, message.extraArgs);
        }
        return keccak256(abi.encode(block.number, msg.sender));
    }
}
