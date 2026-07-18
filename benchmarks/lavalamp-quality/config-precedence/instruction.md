# Repair model configuration precedence

Fix `resolveModel` in `/app/src/config.ts`.

The selected model must use the first non-empty value in this order:

1. `explicit`
2. `environment`
3. `configured`
4. `fallback`

Treat values containing only whitespace as unset. Trim the selected value before returning it. Do not change the exported types or add dependencies.
