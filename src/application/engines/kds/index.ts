// Phase 7 KDS: transactional-outbox realtime evidence + side-effect delivery.
// The transport layer (WebSocket + short-polling fallback + lossless replay)
// lives in src/presentation/kds/; the engines here are transport-agnostic.
export { KdsEventService } from './kds-event-service.ts';
export { SideEffectWorker, requiredSideEffectTypes } from './side-effect-worker.ts';
