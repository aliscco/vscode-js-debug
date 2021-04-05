/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

import { inject, injectable } from 'inversify';
import Cdp from '../cdp/api';
import { DisposableList } from '../common/disposable';
import { disposableTimeout } from '../common/promiseUtil';
import Dap from '../dap/api';
import { IRootDapApi } from '../dap/connection';

const ignoredModulePatterns = /\/node_modules\/|^node\:/;
const consecutiveSessions = 2;
const suggestDelay = 5000;
const minDuration = suggestDelay / 2;

/**
 * Fires an event to indicate to the UI that it should suggest the user open
 * the diagnostic tool. The indicator will be shown when all of the following
 * are true:
 *
 * - At least one breakpoint was set, but no breakpoints bound,
 * - For two consecutive debug sessions,
 * - Where a sourcemap was used for a script outside of the node_modules, or
 *   a remoteRoot is present (since sourcemaps and remote are the cases where
 *   almost all path resolution issues happen)
 */
@injectable()
export class DiagnosticToolSuggester {
  /**
   * Number of sessions that qualify for help. The DiagnosticToolSuggester is
   * a global singleton and we don't care about persistence, so this is fine.
   */
  private static consecutiveQualifyingSessions = 0;

  private readonly disposable = new DisposableList();
  private hadBreakpoint = false;
  private didVerifyBreakpoint = false;
  private hadNonModuleSourcemap = false;
  private startedAt = Date.now();

  private get currentlyQualifying() {
    return this.hadBreakpoint && !this.didVerifyBreakpoint && this.hadNonModuleSourcemap;
  }

  constructor(@inject(IRootDapApi) dap: Dap.Api) {
    if (DiagnosticToolSuggester.consecutiveQualifyingSessions >= consecutiveSessions) {
      this.disposable.push(
        disposableTimeout(() => {
          if (this.currentlyQualifying) {
            dap.suggestDiagnosticTool({});
          }
        }, suggestDelay),
      );
    }
  }

  public notifyHadBreakpoint() {
    this.hadBreakpoint = true;
  }

  /**
   * Attaches the CDP API. Should be called for each
   */
  public attach(cdp: Cdp.Api) {
    if (!this.hadNonModuleSourcemap) {
      const listener = this.disposable.push(
        cdp.Debugger.on('scriptParsed', evt => {
          if (!!evt.sourceMapURL && !ignoredModulePatterns.test(evt.url)) {
            this.hadNonModuleSourcemap = true;
            this.disposable.disposeObject(listener);
          }
        }),
      );
    }

    if (!this.didVerifyBreakpoint) {
      const listener = this.disposable.push(
        cdp.Debugger.on('breakpointResolved', () => {
          this.didVerifyBreakpoint = true;
          this.disposable.disposeObject(listener);
        }),
      );
    }
  }

  /**
   * Should be called before the root debug session ends. It'll fire a DAP
   * message to show a notification if appropriate.
   */
  public dispose() {
    if (this.currentlyQualifying && Date.now() - minDuration > this.startedAt) {
      DiagnosticToolSuggester.consecutiveQualifyingSessions++;
    } else {
      DiagnosticToolSuggester.consecutiveQualifyingSessions = 0;
    }

    this.disposable.dispose();
  }
}
