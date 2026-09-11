/**
 * Global Pricing Requirement Configuration Switch
 * Set to true to make Current Unit Price (IDR) strictly compulsory.
 * Set to false to make Current Unit Price (IDR) optional.
 */
const REQUIRE_UNIT_PRICE = process.env.REQUIRE_UNIT_PRICE === 'true' || false;

module.exports = {
  REQUIRE_UNIT_PRICE
};
