'use strict';
// Public half of the update signing key. Only builds signed with the
// matching private key (kept as the UPDATE_SIGNING_KEY GitHub secret)
// are accepted as updates.
module.exports = `-----BEGIN PUBLIC KEY-----
MCowBQYDK2VwAyEA2JPoe1KO4LIxUaYHRhinrOmXkv+BreggvauH4CE9YX4=
-----END PUBLIC KEY-----
`;
