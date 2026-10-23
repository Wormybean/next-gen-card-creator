// lib/config.ts for the add-on: no environment variables, just the default model lists.

import {
  GEMINI_CARD_MODELS,
  GEMINI_DEFINE_MODELS,
  OPENROUTER_CARD_MODELS,
  OPENROUTER_DEFINE_MODELS,
  withFallback,
  type Service,
} from "../../../lib/models";

const cardModels = (service: Service) => (service === "openrouter" ? OPENROUTER_CARD_MODELS : GEMINI_CARD_MODELS);

export const config = {
  models: cardModels,
  defineModels: (service: Service) =>
    withFallback(service === "openrouter" ? OPENROUTER_DEFINE_MODELS : GEMINI_DEFINE_MODELS, cardModels(service)),
};
