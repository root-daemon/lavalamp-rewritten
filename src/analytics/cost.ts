/**
 * Cost calculation utilities for analytics.
 * Provides functions to calculate token usage costs based on pricing tables.
 */

export interface PricingInfo {
  /**
   * Cost per million input tokens in USD
   * @default 3.0
   */
  inputCostPerMillion: number;
  /**
   * Cost per million output tokens in USD
   * @default 15.0
   */
  outputCostPerMillion: number;
}

/**
 * Calculate token usage costs.
 * @param inputTokens Number of input tokens consumed
 * @param outputTokens Number of output tokens consumed
 * @param inputCostPerMillion Cost per million input tokens
 * @param outputCostPerMillion Cost per million output tokens
 * @returns Total cost rounded to 4 decimal places (cents)
 *
 * @example
 * calculateCost(1000, 500)
 * // => 0.0145 (0.45 input + 0.0075 output = $0.0145)
 *
 * calculateCost(1000, 500, 5.0, 15.0)
 * // => 0.0106 (0.5 input + 0.0075 output = $0.0075)
 */
export function calculateCost(
  inputTokens: number,
  outputTokens: number,
  inputCostPerMillion = 3.0,
  outputCostPerMillion = 15.0,
): number {
  const inputCost = (inputTokens / 1_000_000) * inputCostPerMillion;
  const outputCost = (outputTokens / 1_000_000) * outputCostPerMillion;
  return Math.round((inputCost + outputCost) * 10_000) / 10_000;
}

/**
 * Get pricing information for a model.
 * This is typically used to retrieve pricing from the model registry.
 */
export function getPricing(): PricingInfo {
  return {
    inputCostPerMillion: 3.0,
    outputCostPerMillion: 15.0,
  };
}