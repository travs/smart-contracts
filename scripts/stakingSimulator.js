const Helper = require("../test/helper.js");
const BN = web3.utils.BN;
const { DEPOSIT, DELEGATE, WITHDRAW, NO_ACTION } = require("./simulator/stakingActionsGenerator.js");
const { expectRevert } = require('@openzeppelin/test-helpers');
const StakeGenerator = require("./simulator/stakingActionsGenerator.js");

//global variables
//////////////////
const { zeroBN, zeroAddress } = require("../test/helper.js");

// for keeping score
let depositRuns = 0;
let delegateRuns = 0;
let withdrawRuns = 0;
let noActionRuns = 0;

module.exports.doFuzzStakeTests = async function(
    kyberStaking, NUM_RUNS, kncToken, stakers, epochPeriod
) {
    let result;
    let validity;
    for(let loop = 0; loop < NUM_RUNS; loop++) {
        let operation = StakeGenerator.genNextOp(loop, NUM_RUNS);
        switch(operation) {
            case DEPOSIT:
                result = await StakeGenerator.genDeposit(kncToken, stakers);
                result.dAddress = await kyberStaking.getLatestDelegatedAddress(result.staker);
                console.log(result.msg);
                console.log(`Deposit: staker ${result.staker}, amount: ${result.amount}`);
                validity = await executeAndVerifyDepositInvariants(kyberStaking, result, epochPeriod);
                depositRuns = logResult(validity, depositRuns);
                break;

            case DELEGATE:
                result = await StakeGenerator.genDelegate(stakers);
                console.log(result.msg);
                console.log(`Delegate: staker ${result.staker}, address: ${result.dAddress}`);
                validity= await executeAndVerifyDelegateInvariants(kyberStaking, result, epochPeriod);
                delegateRuns = logResult(validity, delegateRuns);
                break;

            case WITHDRAW:
                result = await StakeGenerator.genWithdraw(kyberStaking, stakers);
                result.dAddress = await kyberStaking.getLatestDelegatedAddress(result.staker);
                console.log(result.msg);
                console.log(`Withdrawal: staker ${result.staker}, amount: ${result.amount}`);
                if (result.isValid) {
                    try {
                        await kyberStaking.withdraw(result.amount, {from: result.staker});
                    } catch(e) {
                        console.log('Valid withdrawal, but failed');
                        console.log(e);
                        numWithdrawFail++;
                        break;
                    }
                } else {
                    await expectRevert.unspecified(
                        kyberStaking.withdraw(result.amount, {from: result.staker})
                    );
                }
                // validity = await verifyWithdrawInvariants(kyberStaking, stakers, result);
                validity = {isValid: true};
                withdrawRuns = logResult(validity, withdrawRuns);
                break;
            case NO_ACTION:
                console.log("do nothing for this epoch...");
                // Advance time by a bit
                let currentBlockTime = await Helper.getCurrentBlockTime();
                await Helper.mineNewBlockAt(
                    currentBlockTime + Helper.getRandomInt(10, epochPeriod.toString())
                );
                // validity = await verifyNoActionInvariants(kyberStaking, stakers, result);
                validity = {isValid: true};
                noActionRuns = logResult(validity, noActionRuns);
                break;
            default:
                console.log("unexpected operation: " + operation);
                break;
        }
    }

    console.log(`--- SIM RESULTS ---`);
    console.log(`Deposit: ${depositRuns}`);
    console.log(`Delegate: ${delegateRuns}`);
    console.log(`Withdraw: ${withdrawRuns}`);
    console.log(`Do nothing: ${noActionRuns}`);
}

async function executeAndVerifyDepositInvariants(kyberStaking, result, epochPeriod) {
    let isValid = true;
    let initState = await getState(kyberStaking, result, null);
    let currentBlockTime = await Helper.getCurrentBlockTime();
    await Helper.setNextBlockTimestamp(currentBlockTime + Helper.getRandomInt(5, epochPeriod.toNumber() / 3));

    // do deposit
    if (result.isValid) {
        try {
            await kyberStaking.deposit(result.amount, {from: result.staker});
        } catch(e) {
            console.log('Valid deposit, but failed');
            console.log(e);
            return false;
        }
    } else {
        await expectRevert.unspecified(
            await kyberStaking.deposit(result.amount, {from: result.staker})
        );
    }

    let newState = await getState(kyberStaking, result, initState.oldDelegateAddress);
    isValid &= (await verifyDepositChanges(initState, newState, result));
    return {
        isValid: isValid,
        states: {'initState': initState, 'newState': newState}
    }
}

async function executeAndVerifyDelegateInvariants(kyberStaking, result, epochPeriod) {
    let isValid = true;
    let initState = await getState(kyberStaking, result, null);
    let currentBlockTime = await Helper.getCurrentBlockTime();
    await Helper.setNextBlockTimestamp(currentBlockTime + Helper.getRandomInt(5, epochPeriod.toNumber() / 3));

    // do delegate
    if (result.dAddress == zeroAddress) {
        await expectRevert(
            kyberStaking.delegate(result.dAddress, {from: result.staker}),
            "delegate: delegated address 0"
        );
    } else {
        await kyberStaking.delegate(result.dAddress, {from: result.staker});
    }

    let newState = await getState(kyberStaking, result, initState.oldDelegateAddress);
    isValid &= (await verifyDelegateChanges(initState, newState, result));
    return {
        isValid: isValid,
        states: {'initState': initState, 'newState': newState}
    }
}

async function getState(kyberStaking, result, oldDelegateAddress) {
    let res = {
        'staker': {},
        'oldDelegate': {},
        'newDelegate': {}
    };
    let currEpochNum = await kyberStaking.getCurrentEpochNumber();
    res.epochNum = currEpochNum;
    let nextEpochNum = currEpochNum.add(new BN(1));;
    
    res.staker.dataCurEpoch = await getStakerDataForEpoch(kyberStaking, result.staker, currEpochNum);
    res.oldDelegateAddress = (oldDelegateAddress == undefined) ?
        (await kyberStaking.getLatestDelegatedAddress(result.staker)) :
        oldDelegateAddress;
    res.newDelegateAddress = result.dAddress;

    res.oldDelegate.dataCurEpoch = await getStakerDataForEpoch(kyberStaking, res.oldDelegateAddress, currEpochNum);
    res.newDelegate.dataCurEpoch = await getStakerDataForEpoch(kyberStaking, res.newDelegateAddress, currEpochNum);

    res.staker.dataNextEpoch = await getStakerDataForEpoch(kyberStaking, result.staker, nextEpochNum);
    res.oldDelegate.dataNextEpoch = await getStakerDataForEpoch(kyberStaking, res.oldDelegateAddress, nextEpochNum);
    res.newDelegate.dataNextEpoch = await getStakerDataForEpoch(kyberStaking, res.newDelegateAddress, nextEpochNum);

    res.staker.latestData = await getLatestStakeData(kyberStaking, result.staker);
    res.oldDelegate.latestData = await getLatestStakeData(kyberStaking, res.oldDelegateAddress);
    res.newDelegate.latestData = await getLatestStakeData(kyberStaking, res.newDelegateAddress);

    res.staker.initedCurEpoch = await kyberStaking.getHasInitedValue(result.staker, currEpochNum);
    res.oldDelegate.initedCurEpoch = await kyberStaking.getHasInitedValue(res.oldDelegateAddress, currEpochNum);
    res.newDelegate.initedCurEpoch = await kyberStaking.getHasInitedValue(res.newDelegateAddress, currEpochNum);

    res.staker.initedNextEpoch = await kyberStaking.getHasInitedValue(result.staker, nextEpochNum);
    res.oldDelegate.initedNextEpoch = await kyberStaking.getHasInitedValue(res.oldDelegateAddress, nextEpochNum);
    res.newDelegate.initedNextEpoch = await kyberStaking.getHasInitedValue(res.newDelegateAddress, nextEpochNum);

    return res;
}

async function getStakerDataForEpoch(kyberStaking, staker, epochNum) {
    let res = await kyberStaking.getStakerDataForPastEpoch(staker, epochNum);
    res.stake = res._stake;
    res.dStake = res._delegatedStake;
    res.dAddress = res._delegatedAddress;
    delete res._stake;
    delete res._delegatedStake;
    delete res._delegatedAddress;
    return res;
}

async function getLatestStakeData(kyberStaking, address) {
    let res = {
        'stake': zeroBN,
        'dStake': zeroBN,
        'dAddress': zeroAddress
    }
    res.stake = await kyberStaking.getLatestStakeBalance(address);
    res.dStake = await kyberStaking.getLatestDelegatedStake(address);
    res.dAddress = await kyberStaking.getLatestDelegatedAddress(address);
    return res;
}

async function verifyDepositChanges(initState, newState, result) {
    let isValid = true;
    isValid &= (await verifyEpochInvariants(DEPOSIT, initState, newState));
    let depositAmt = zeroBN;

    // Compare latestData structures
    // staker's deposit should have increased
    depositAmt = newState.staker.latestData.stake.sub(initState.staker.latestData.stake);
    isValid &= (depositAmt.eq(result.amount));
    isValid &= (newState.staker.latestData.dStake.eq(initState.staker.latestData.dStake));
    if (initState.staker.initedCurEpoch) {
        // staker's delegateAddress should have remained the same
        isValid &= (newState.staker.latestData.dAddress == initState.staker.latestData.dAddress);
        isValid &= (newState.newDelegateAddress == initState.newDelegateAddress);
    } else {
        isValid &= ([result.staker, initState.staker.latestData.dAddress].includes(newState.staker.latestData.dAddress));
    }

    // Compare nextEpoch changes
    if (initState.epochNum.eq(newState.epochNum)) {
        // Deposit was done in the same epoch
        isValid &= assertSameStakerData(newState.staker.latestData, newState.staker.dataNextEpoch);
        if (initState.staker.initedNextEpoch) {
            // staker's stake should increase for next epoch, other info stays the same
            depositAmt = newState.staker.dataNextEpoch.stake.sub(initState.staker.dataNextEpoch.stake);
            isValid &= (depositAmt.eq(result.amount));
            isValid &= newState.staker.dataNextEpoch.dStake.eq(initState.staker.dataNextEpoch.dStake);
            isValid &= (newState.staker.dataNextEpoch.dAddress == initState.staker.dataNextEpoch.dAddress);
        }

        // staker == delegate, should have same info
        if (newState.newDelegateAddress == result.staker) {
            isValid &= assertSameDataStruct(newState.staker, newState.newDelegate);
        } else if (newState.newDelegateAddress != result.staker || newState.newDelegateAddress != zeroAddress) {
            // With delegation: delegate dStake should have increased
            depositAmt = newState.newDelegate.latestData.dStake.sub(initState.newDelegate.latestData.dStake);
            isValid &= (depositAmt.eq(result.amount));
            // stake and dAddress should remain unchanged
            isValid &= newState.newDelegate.latestData.stake.eq(initState.newDelegate.latestData.stake);
            isValid &= (newState.newDelegate.latestData.dAddress == initState.newDelegate.latestData.dAddress);
            isValid &= assertSameStakerData(newState.newDelegate.latestData, newState.newDelegate.dataNextEpoch);
        }
        // delegate has changed
        if (newState.oldDelegateAddress != newState.newDelegateAddress) {
            // assert that old delegate stake will not increase for next epoch
            isValid &= (initState.oldDelegate.latestData.dStake.eq(newState.oldDelegate.latestData.dStake));
            if (initState.oldDelegate.initedNextEpoch) {
                isValid &= (initState.oldDelegate.dataNextEpoch.dStake.eq(newState.oldDelegate.dataNextEpoch.dStake));
            } 
        }
    } else {
        // Deposit was done in the next epoch
        isValid &= assertSameStakerData(newState.staker.latestData, newState.staker.dataNextEpoch);
        if (initState.initedNextEpoch) {
            isValid &= assertSameStakerData(newState.staker.dataCurEpoch, initState.staker.dataNextEpoch);
        }
        if (newState.newDelegateAddress == result.staker) {
            isValid &= assertSameDataStruct(newState.staker, newState.newDelegate);
        } else if (newState.newDelegateAddress != result.staker || newState.newDelegateAddress != zeroAddress) {
            // With delegation
            depositAmt = newState.newDelegate.latestData.dStake.sub(initState.newDelegate.latestData.dStake);
            isValid &= (depositAmt.eq(result.amount));
            isValid &= newState.newDelegate.latestData.stake.eq(initState.newDelegate.latestData.stake);
            isValid &= (newState.newDelegate.latestData.dAddress == initState.newDelegate.latestData.dAddress);
            isValid &= assertSameStakerData(newState.newDelegate.latestData, newState.newDelegate.dataNextEpoch);
            if (initState.oldDelegate.initedNextEpoch) {
                isValid &= assertSameStakerData(initState.oldDelegate.dataNextEpoch, newState.oldDelegate.dataCurEpoch);
            }
            if (initState.newDelegate.initedNextEpoch) {
                isValid &= assertSameStakerData(initState.newDelegate.dataNextEpoch, newState.newDelegate.dataCurEpoch);
            }
        }

        if (newState.oldDelegateAddress != newState.newDelegateAddress) {
            // assert that old delegate stake did not increase this epoch, and will not increase for next epoch
            isValid &= (initState.oldDelegate.latestData.dStake.eq(newState.oldDelegate.latestData.dStake));
            isValid &= (initState.oldDelegate.dataNextEpoch.dStake.eq(newState.oldDelegate.dataCurEpoch.dStake));
        }
    }
    return isValid;
}

async function verifyDelegateChanges(initState, newState, result) {
    let isValid = true;
    let stakeAmt;
    isValid &= (await verifyEpochInvariants(DELEGATE, initState, newState));
    // Case 1: New delegation
    if (result.dAddress != result.staker && initState.oldDelegateAddress == result.staker) {
        // old delegate == staker
        if (initState.staker.initedCurEpoch) {
            isValid &= (assertSameDataStruct(initState.staker, initState.oldDelegate));
        }
        // staker's latestData == dataNextEpoch
        isValid &= (assertSameStakerData(newState.staker.latestData, newState.staker.dataNextEpoch));

        // new delegate's latestData == dataNextEpoch
        isValid &= (assertSameStakerData(newState.newDelegate.latestData, newState.newDelegate.dataNextEpoch));

        // delegate address should have changed
        isValid &= (newState.staker.latestData.dAddress == result.dAddress);

        // if delegate hasn't changed to new one yet (could be delegating to same person)
        if (initState.staker.latestData.dAddress != result.dAddress) {
            // check newDelegate's dStake increased by staker's stake
            stakeAmt = newState.newDelegate.latestData.dStake.sub(newState.staker.latestData.stake);
            isValid &= (stakeAmt.eq(initState.newDelegate.latestData.dStake));
        } else {
            // otherwise, amount should remain the same
            isValid &= (newState.newDelegate.latestData.dStake.eq(initState.newDelegate.latestData.dStake));
        }
    } else if (result.dAddress != result.staker && initState.oldDelegateAddress != result.staker) {
        // Case 2: Delegating from one pool operator to another
        if (initState.staker.initedCurEpoch) {
            // old delegate should remain unchanged
            isValid &= (initState.oldDelegateAddress == newState.oldDelegateAddress);
        }
        // staker's, oldDelegate's and newDelegate's latestData == dataNextEpoch
        // Note: If delegating to same pool operator, pool operator's data not inited
        isValid &= (assertSameStakerData(newState.staker.latestData, newState.staker.dataNextEpoch));
        if (newState.oldDelegate.initedNextEpoch) {
            isValid &= (assertSameStakerData(newState.oldDelegate.latestData, newState.oldDelegate.dataNextEpoch));
        }
        if (newState.newDelegate.initedNextEpoch) {
            isValid &= (assertSameStakerData(newState.newDelegate.latestData, newState.newDelegate.dataNextEpoch));
        }

        // delegate address should have changed
        isValid &= (newState.staker.latestData.dAddress == result.dAddress);
        isValid &= (newState.newDelegateAddress == result.dAddress);

        // check that staker's stake and dStake remains unchanged
        isValid &= (newState.staker.latestData.stake.eq(initState.staker.latestData.stake));
        isValid &= (newState.staker.latestData.dStake.eq(initState.staker.latestData.dStake));

        // if calling delegate with same address as oldDelegate 
        if (initState.oldDelegateAddress == result.dAddress) {
            // address did not change at all
            if (initState.staker.latestData.dAddress == initState.oldDelegateAddress) {
                // dStake should remain the same
                isValid &= (newState.oldDelegate.latestData.dStake.eq(initState.oldDelegate.latestData.dStake));
            } else {
                // delegate to someone else, but delegating back to same pool master
                stakeAmt = newState.oldDelegate.latestData.dStake.sub(initState.oldDelegate.latestData.dStake);
                isValid &= (stakeAmt.eq(newState.staker.latestData.stake));
            }
        } else {
            // check oldDelegate stake decreased for latestData
            stakeAmt = initState.oldDelegate.latestData.dStake.sub(newState.oldDelegate.latestData.dStake);
            let expectedDecreaseAmt = newState.oldDelegate.initedCurEpoch ? newState.staker.latestData.stake : zeroBN;;
            isValid &= (stakeAmt.eq(expectedDecreaseAmt));

            // check newDelegate stake increased
            stakeAmt = newState.newDelegate.latestData.dStake.sub(initState.newDelegate.latestData.dStake);
            isValid &= (stakeAmt.eq(newState.staker.latestData.stake));

            // oldDelegate and newDelegate dStake should remain unchanged for current epoch
            if (initState.epochNum.eq(newState.epochNum)) {
                if (initState.oldDelegate.initedCurEpoch) {
                    isValid &= (initState.oldDelegate.dataCurEpoch.dStake.eq(newState.oldDelegate.dataCurEpoch.dStake));
                }
                if (initState.newDelegate.initedCurEpoch) {
                    isValid &= (initState.newDelegate.dataCurEpoch.dStake.eq(newState.newDelegate.dataCurEpoch.dStake));
                }
            } else {
                if (initState.oldDelegate.initedNextEpoch) {
                    isValid &= (initState.oldDelegate.dataNextEpoch.dStake.eq(newState.oldDelegate.dataCurEpoch.dStake));
                }
                if (initState.newDelegate.initedNextEpoch) {
                    isValid &= (initState.newDelegate.dataNextEpoch.dStake.eq(newState.newDelegate.dataCurEpoch.dStake));
                }
            }
        }
    } else if (result.dAddress == result.staker) {
        // Case 3: Un-delegation (Delegation back to self)
        // Same as case 2, except that newDelegate dStake should not increase, but remain unchanged
        if (initState.staker.initedCurEpoch) {
            // old delegate should remain unchanged
            isValid &= (initState.oldDelegateAddress == newState.oldDelegateAddress);
        }
        // staker's, oldDelegate's and newDelegate's latestData == dataNextEpoch
        isValid &= (assertSameStakerData(newState.staker.latestData, newState.staker.dataNextEpoch));
        if (newState.oldDelegate.initedNextEpoch) {
            isValid &= (assertSameStakerData(newState.oldDelegate.latestData, newState.oldDelegate.dataNextEpoch));
        }
        // staker == newDelegate
        isValid &= (assertSameDataStruct(newState.newDelegate, newState.staker));

        // delegate address should have changed
        isValid &= (newState.staker.latestData.dAddress == result.dAddress);
        isValid &= (newState.newDelegateAddress == result.dAddress);

        // check that staker's stake and dStake remains unchanged
        isValid &= (newState.staker.latestData.stake.eq(initState.staker.latestData.stake));
        isValid &= (newState.staker.latestData.dStake.eq(initState.staker.latestData.dStake));

        // if calling delegate with same address as oldDelegate 
        if (initState.oldDelegateAddress == result.dAddress) {
            // address did not change at all
            if (initState.staker.latestData.dAddress == initState.oldDelegateAddress) {
                // dStake should remain the same
                isValid &= (newState.oldDelegate.latestData.dStake.eq(initState.oldDelegate.latestData.dStake));
            } else {
                // delegate to someone else, but delegating back to same pool master
                stakeAmt = newState.oldDelegate.latestData.dStake.sub(initState.oldDelegate.latestData.dStake);
                isValid &= (stakeAmt.eq(newState.staker.latestData.stake));
            }
        } else {
            // check oldDelegate stake decreased for latestData
            stakeAmt = initState.oldDelegate.latestData.dStake.sub(newState.oldDelegate.latestData.dStake);
            let expectedDecreaseAmt = newState.oldDelegate.initedCurEpoch ? newState.staker.latestData.stake : zeroBN;;
            isValid &= (stakeAmt.eq(expectedDecreaseAmt));

            // oldDelegate and newDelegate dStake should remain unchanged for current epoch
            if (initState.epochNum.eq(newState.epochNum)) {
                if (initState.oldDelegate.initedCurEpoch) {
                    isValid &= (initState.oldDelegate.dataCurEpoch.dStake.eq(newState.oldDelegate.dataCurEpoch.dStake));
                }
                if (initState.newDelegate.initedCurEpoch) {
                    isValid &= (initState.newDelegate.dataCurEpoch.dStake.eq(newState.newDelegate.dataCurEpoch.dStake));
                }
            } else {
                if (initState.oldDelegate.initedNextEpoch) {
                    isValid &= (initState.oldDelegate.dataNextEpoch.dStake.eq(newState.oldDelegate.dataCurEpoch.dStake));
                }
                if (initState.newDelegate.initedNextEpoch) {
                    isValid &= (initState.newDelegate.dataNextEpoch.dStake.eq(newState.newDelegate.dataCurEpoch.dStake));
                }
            }
        }
    } else {
        console.log("Unrecognised case....");
        logStates({'initState': initState, 'newState': newState});
        process.exit(0);
    }
    return isValid;
}

async function verifyEpochInvariants(operation, initState, newState) {
    let isValid;
    switch(operation) {
        case WITHDRAW:
            break;
        default:
            let actionDoneInSameEpoch = initState.epochNum.eq(newState.epochNum);
            isValid = assertSameStakerDataInvariants(initState.staker, newState.staker, actionDoneInSameEpoch);
            isValid &= (assertSameStakerDataInvariants(initState.oldDelegate, newState.oldDelegate, actionDoneInSameEpoch));
            isValid &= (assertSameStakerDataInvariants(initState.newDelegate, newState.newDelegate, actionDoneInSameEpoch));
    }
    return isValid;
}

function assertSameStakerDataInvariants(initStakerData, newStakerData, actionDoneInSameEpoch) {
    let isValid = true;

    if (actionDoneInSameEpoch) {
        if (initStakerData.initedCurEpoch) {
            isValid &= assertSameStakerData(initStakerData.dataCurEpoch, newStakerData.dataCurEpoch);
            if (!isValid) {
                console.log(`dataCurEpochs don't match`);
            }
        }
        if (initStakerData.initedNextEpoch) {
            isValid &= assertSameStakerData(newStakerData.dataNextEpoch, newStakerData.latestData);
            if (!isValid) {
                console.log(`newStaker latestData & dataNextEpoch don't match`);
            }
        }
    } else {
        if (initStakerData.initedNextEpoch) {
            isValid &= assertSameStakerData(initStakerData.dataNextEpoch, newStakerData.dataCurEpoch);
            if (!isValid) {
                console.log(`Diff epochs: newStaker dataCurEpoch & initStakerData.dataNextEpoch don't match`);
            }
        }
        if (newStakerData.initedNextEpoch) {
            isValid &= assertSameStakerData(newStakerData.dataNextEpoch, newStakerData.latestData);
            if (!isValid) {
                console.log(`Diff epochs: newStaker dataNextEpoch & latestData don't match`);
            }
        }
    }
    return isValid;
}

function assertSameStakerData(stakerData1, stakerData2) {
    let isValid = true;
    isValid &= (stakerData1.stake.eq(stakerData2.stake));
    if (!isValid) {
        console.log(`stakes don't match...`);
        console.log(`${stakerData1.stake.toString()} != ${stakerData2.stake.toString()}`);
    }
    isValid &= (stakerData1.dStake.eq(stakerData2.dStake));
    if (!isValid) {
        console.log(`delegated stakes don't match...`);
        console.log(`${stakerData1.dStake.toString()} != ${stakerData2.dStake.toString()}`);
    }
    isValid &= (stakerData1.dAddress == stakerData2.dAddress);
    if (!isValid) {
        console.log(`delegated addresses don't match...`);
        console.log(`${stakerData1.dAddress.toString()} != ${stakerData2.dAddress.toString()}`);
    }
    return isValid;
}

function assertSameDataStruct(initStaker, newStaker) {
    let isValid = true;
    isValid &= assertSameStakerData(initStaker.dataCurEpoch, newStaker.dataCurEpoch);
    isValid &= assertSameStakerData(initStaker.dataNextEpoch, newStaker.dataNextEpoch);
    isValid &= assertSameStakerData(initStaker.latestData, newStaker.latestData);
    return isValid;
}

function logResult(validity, score) {
    if (!validity.isValid) {
        logStates(validity.states);
        process.exit(0);
    } else {
        score += 1;
    }
    return score;
}

function logStates(states) {
    console.log(`---INITIAL STATE---`);
    logState(states.initState);
    console.log(`---RESULTING STATE---`);
    logState(states.newState);
}

function logState(state) {
    console.log(`epochNum: ${state.epochNum}`);
    console.log(`oldDAddr: ${state.oldDelegateAddress}`);
    console.log(`newDAddr: ${state.newDelegateAddress}`);

    console.log(`staker's curEpochStake: ${state.staker.dataCurEpoch.stake.toString()}`);
    console.log(`staker's curEpochDStake: ${state.staker.dataCurEpoch.dStake.toString()}`);
    console.log(`staker's curEpochDAddr: ${state.staker.dataCurEpoch.dAddress.toString()}`);

    console.log(`oldDAddr's curEpochStake: ${state.oldDelegate.dataCurEpoch.stake.toString()}`);
    console.log(`oldDAddr's curEpochDStake: ${state.oldDelegate.dataCurEpoch.dStake.toString()}`);
    console.log(`oldDAddr's curEpochDAddr: ${state.oldDelegate.dataCurEpoch.dAddress.toString()}`);
    
    console.log(`newDAddr's curEpochStake: ${state.newDelegate.dataCurEpoch.stake.toString()}`);
    console.log(`newDAddr's curEpochDStake: ${state.newDelegate.dataCurEpoch.dStake.toString()}`);
    console.log(`newDAddr's curEpochDAddr: ${state.newDelegate.dataCurEpoch.dAddress.toString()}`);

    console.log(`staker's nextEpochStake: ${state.staker.dataNextEpoch.stake.toString()}`);
    console.log(`staker's nextEpochDStake: ${state.staker.dataNextEpoch.dStake.toString()}`);
    console.log(`staker's nextEpochDAddr: ${state.staker.dataNextEpoch.dAddress.toString()}`);

    console.log(`oldDAddr's nextEpochStake: ${state.oldDelegate.dataNextEpoch.stake.toString()}`);
    console.log(`oldDAddr's nextEpochDStake: ${state.oldDelegate.dataNextEpoch.dStake.toString()}`);
    console.log(`oldDAddr's nextEpochDAddr: ${state.oldDelegate.dataNextEpoch.dAddress.toString()}`);
    
    console.log(`newDAddr's nextEpochStake: ${state.newDelegate.dataNextEpoch.stake.toString()}`);
    console.log(`newDAddr's nextEpochDStake: ${state.newDelegate.dataNextEpoch.dStake.toString()}`);
    console.log(`newDAddr's nextEpochDAddr: ${state.newDelegate.dataNextEpoch.dAddress.toString()}`);

    console.log(`staker's latestDataStake: ${state.staker.latestData.stake.toString()}`);
    console.log(`staker's latestDataDStake: ${state.staker.latestData.dStake.toString()}`);
    console.log(`staker's latestDataDAddr: ${state.staker.latestData.dAddress.toString()}`);

    console.log(`oldDAddr's latestDataStake: ${state.oldDelegate.latestData.stake.toString()}`);
    console.log(`oldDAddr's latestDataDStake: ${state.oldDelegate.latestData.dStake.toString()}`);
    console.log(`oldDAddr's latestDataDAddr: ${state.oldDelegate.latestData.dAddress.toString()}`);
    
    console.log(`newDAddr's latestDataStake: ${state.newDelegate.latestData.stake.toString()}`);
    console.log(`newDAddr's latestDataDStake: ${state.newDelegate.latestData.dStake.toString()}`);
    console.log(`newDAddr's latestDataDAddr: ${state.newDelegate.latestData.dAddress.toString()}`);

    console.log(`staker initiedCurEpoch: ${state.staker.initedCurEpoch}`);
    console.log(`oldDAddr initiedCurEpoch: ${state.oldDelegate.initedCurEpoch}`);
    console.log(`newDAddr initiedCurEpoch: ${state.newDelegate.initedCurEpoch}`);

    console.log(`staker initiedNextEpoch: ${state.staker.initedNextEpoch}`);
    console.log(`oldDAddr initiedNextEpoch: ${state.oldDelegate.initedNextEpoch}`);
    console.log(`newDAddr initiedNextEpoch: ${state.newDelegate.initedNextEpoch}`);
}
