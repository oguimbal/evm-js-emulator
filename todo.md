# TODO
- implement ops gas
# TESTS TO WRITE (& fix)
- Extensive tests of "ADDRESS", "ORIGIN" and "CALLER" opcodes... specially in the context of a delegatecall (i'm pretty sure I messed that up)
- Reentrant calls (with value, with storage changes, reentrant from delegatecall... look for conflicts! The current implem of state passing is fragile and hazardous)
- can `returndatacopy` be accessed in a `delegatecall`, if the last call has been performed in the parent ? (currently implemented: no)
- can `returndatacopy` access data that has been returned outside of the bounds specified by the call statment ? (currently implemented: yes)
