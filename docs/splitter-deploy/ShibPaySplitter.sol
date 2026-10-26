// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

/// @title ShibPaySplitter
/// @notice Pays a merchant and burns a merchant-chosen share of the payment in
/// one transaction. There is no owner, no fee and no upgrade path, and tokens
/// never rest here: they move straight from the payer to the merchant and to
/// the burn address. The contract only ever pulls from msg.sender, so an
/// approval given to it cannot be spent by anyone else.
contract ShibPaySplitter {
    /// @notice The burn address used on every chain.
    address public constant BURN = 0x000000000000000000000000000000000000dEaD;

    /// @notice 100% in basis points.
    uint16 public constant MAX_BPS = 10_000;

    /// @param orderId Merchant's order reference (keccak256 of the order string).
    /// @param token The ERC-20 paid, or address(0) for the chain's native coin.
    /// @param amount Total paid by the payer, burn included.
    /// @param burned The part of `amount` sent to BURN.
    event Paid(
        bytes32 indexed orderId,
        address indexed payer,
        address indexed merchant,
        address token,
        uint256 amount,
        uint256 burned
    );

    error InvalidMerchant();
    error InvalidBurn();
    error ZeroAmount();
    error NotAContract();
    error TransferFailed();

    /// @notice Pay `amount` of `token` to `merchant`, burning `burnBps` of it.
    function pay(address token, address merchant, uint256 amount, uint16 burnBps, bytes32 orderId) external {
        uint256 burned = _split(merchant, amount, burnBps);
        if (token.code.length == 0) revert NotAContract();

        if (burned != 0) _pull(token, BURN, burned);
        if (amount != burned) _pull(token, merchant, amount - burned);

        emit Paid(orderId, msg.sender, merchant, token, amount, burned);
    }

    /// @notice Pay msg.value of the native coin (e.g. BONE on Shibarium) to `merchant`, burning `burnBps` of it.
    function payNative(address merchant, uint16 burnBps, bytes32 orderId) external payable {
        uint256 burned = _split(merchant, msg.value, burnBps);

        if (burned != 0) _send(BURN, burned);
        if (msg.value != burned) _send(merchant, msg.value - burned);

        emit Paid(orderId, msg.sender, merchant, address(0), msg.value, burned);
    }

    function _split(address merchant, uint256 amount, uint16 burnBps) private pure returns (uint256) {
        if (merchant == address(0) || merchant == BURN) revert InvalidMerchant();
        if (burnBps > MAX_BPS) revert InvalidBurn();
        if (amount == 0) revert ZeroAmount();
        return (amount * burnBps) / MAX_BPS;
    }

    /// @dev transferFrom(msg.sender, to, value), accepting tokens that return nothing.
    function _pull(address token, address to, uint256 value) private {
        (bool ok, bytes memory data) =
            token.call(abi.encodeWithSelector(0x23b872dd, msg.sender, to, value));
        if (!ok || (data.length != 0 && !abi.decode(data, (bool)))) revert TransferFailed();
    }

    function _send(address to, uint256 value) private {
        (bool ok,) = to.call{value: value}("");
        if (!ok) revert TransferFailed();
    }
}
