import { useEffect, useState } from 'react';
import type { ExtensionUIEvent } from '../../shared/extension-ui';
import { AnsiText } from './AnsiText';

const EMPTY_FRAMES: readonly string[] = [];

export interface ExtensionStatusProps {
  readonly events: readonly ExtensionUIEvent[];
  readonly transportReady: boolean;
}

export function ExtensionStatus({ events, transportReady }: ExtensionStatusProps) {
  const title = [...events].reverse().find((event) => event.type === 'title');
  const activeTitle = title?.type === 'title' ? title.title : undefined;
  const statuses = events.filter((event): event is Extract<ExtensionUIEvent, { type: 'status' }> => event.type === 'status' && event.text !== null);
  const widgets = events.filter((event): event is Extract<ExtensionUIEvent, { type: 'widget' }> => event.type === 'widget' && event.content !== null);
  const notices = events.filter((event): event is Extract<ExtensionUIEvent, { type: 'notification' }> => event.type === 'notification');
  const unsupported = events.filter((event): event is Extract<ExtensionUIEvent, { type: 'unsupported' }> => event.type === 'unsupported');
  const workingMessage = [...events].reverse().find((event) => event.type === 'working-message');
  const workingVisible = [...events].reverse().find((event) => event.type === 'working-visible');
  const workingIndicator = [...events].reverse().find((event) => event.type === 'working-indicator');
  const hiddenThinking = [...events].reverse().find((event) => event.type === 'hidden-thinking-label');
  const workingLabel = workingMessage?.type === 'working-message' ? workingMessage.message : null;
  const isWorking = workingVisible?.type === 'working-visible' && workingVisible.visible;
  const indicator = workingIndicator?.type === 'working-indicator' ? workingIndicator.options : null;
  const frames = indicator?.frames ?? EMPTY_FRAMES;
  const [frameIndex, setFrameIndex] = useState(0);
  const [infoHidden, setInfoHidden] = useState(false);
  const infoCount = notices.filter((event) => event.level !== 'error' && event.level !== 'warning').length;
  const visibleNotices = infoHidden ? notices.filter((event) => event.level === 'error' || event.level === 'warning') : notices;

  useEffect(() => {
    setFrameIndex(0);
    if (frames.length < 2 || typeof window === 'undefined' || window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    const delay = indicator?.intervalMs && indicator.intervalMs > 0 ? indicator.intervalMs : 100;
    const timer = window.setInterval(() => setFrameIndex((index) => (index + 1) % frames.length), delay);
    return () => window.clearInterval(timer);
  }, [indicator?.intervalMs, frames]);

  return (
    <section className="extension-status" aria-label="Extension status updates" aria-live="polite">
      <div className="extension-status-topline">
        <span className={`extension-status-light${transportReady ? ' is-ready' : ''}`} aria-hidden="true" />
        {activeTitle ? <AnsiText text={activeTitle} /> : <span>{transportReady ? 'Extension UI connected' : 'Extension UI unavailable'}</span>}
      </div>
      {isWorking && (
        <div className="extension-working" role="status">
          {frames.length ? <span className="extension-working-frame" aria-hidden="true"><AnsiText text={frames[frameIndex % frames.length]} /></span> : <span className="extension-working-pulse" aria-hidden="true" />}
          <AnsiText text={workingLabel || 'Extension is working'} />
        </div>
      )}
      {hiddenThinking?.type === 'hidden-thinking-label' && hiddenThinking.label && (
        <div className="extension-thinking-label"><AnsiText text={hiddenThinking.label} /></div>
      )}
      {statuses.length > 0 && (
        <ul className="extension-status-list" aria-label="Current extension statuses">
          {statuses.map((event) => <li key={event.key}><span className="extension-status-key">{event.key}</span><AnsiText className="extension-status-text" text={event.text ?? ''} /></li>)}
        </ul>
      )}
      {widgets.map((event) => (
        <div className="extension-widget" key={`${event.key}:${event.placement}`} data-placement={event.placement}>
          <div className="extension-widget-label">{event.key}</div>
          {event.content?.map((line, index) => <div className="extension-widget-line" key={`${index}-${line}`}><AnsiText text={line} /></div>)}
        </div>
      ))}
      {(notices.length > 0 || unsupported.length > 0) && (
        <section className="extension-notices" aria-label="Extension notices">
          <header className="extension-notices-header">
            <span>Notices <span className="extension-notices-count">{notices.length + unsupported.length}</span></span>
            {infoCount > 0 && <button type="button" className="extension-notices-toggle" aria-expanded={!infoHidden} onClick={() => setInfoHidden((hidden) => !hidden)}>{infoHidden ? `Show ${infoCount} info` : 'Hide info'}</button>}
          </header>
          <ul className="extension-notice-list">
            {visibleNotices.map((event, index) => (
              <li className={`extension-notice extension-notice-${event.level}`} role={event.level === 'error' ? 'alert' : 'status'} key={`${index}-${event.message}`}>
                <span className="extension-notice-mark" aria-hidden="true">{event.level === 'error' ? '\uf057' : event.level === 'warning' ? '\uf071' : '\uf05a'}</span>
                <AnsiText className="extension-notice-text" text={event.message} />
              </li>
            ))}
            {unsupported.map((event, index) => (
              <li className="extension-notice extension-notice-warning" role="status" key={`${index}-${event.operation}`}>
                <span className="extension-notice-mark" aria-hidden="true">{'\uf071'}</span>
                <span className="extension-notice-text">The extension requested “{event.operation}”, which this host does not currently support.</span>
              </li>
            ))}
          </ul>
        </section>
      )}
    </section>
  );
}
