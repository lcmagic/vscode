/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
/// <amd-dependency path="vs/css!./folding" />

'use strict';

import {RunOnceScheduler} from 'vs/base/common/async';
import {Range} from 'vs/editor/common/core/range';
import EditorCommon = require('vs/editor/common/editorCommon');
import {IMouseEvent, ICodeEditor} from 'vs/editor/browser/editorBrowser';
import {INullService} from 'vs/platform/instantiation/common/instantiation';
import {IDisposable, disposeAll} from 'vs/base/common/lifecycle';
import Modes = require('vs/editor/common/modes');
import {EditorBrowserRegistry} from 'vs/editor/browser/editorBrowserExtensions';
import {TPromise} from 'vs/base/common/winjs.base';
import foldStrategy = require('vs/editor/contrib/folding/common/indentFoldStrategy');
import {IFoldingRange, toString as rangeToString} from 'vs/editor/contrib/folding/common/foldingRange';

let log = function(msg: string) {
	console.log(msg);
};

class CollapsableRegion {

	private decorationIds: string[];
	private _isCollapsed:boolean;

	private _lastRange: IFoldingRange;

	public constructor(range:IFoldingRange, model:EditorCommon.IModel, changeAccessor:EditorCommon.IModelDecorationsChangeAccessor, isCollapsed:boolean) {
		this._isCollapsed = isCollapsed;
		this.decorationIds = [];
		this.update(range, model, changeAccessor);
	}

	public get isCollapsed() : boolean {
		return this._isCollapsed;
	}

	public get lastRange() :IFoldingRange {
		return this._lastRange;
	}

	public setCollapsed(isCollaped: boolean, changeAccessor:EditorCommon.IModelDecorationsChangeAccessor) : void {
		this._isCollapsed = isCollaped;
		if (this.decorationIds.length > 0) {
			changeAccessor.changeDecorationOptions(this.decorationIds[0], this.getVisualDecorationOptions());
		}
	}

	public getDecorationRange(model:EditorCommon.IModel) : EditorCommon.IEditorRange {
		if (this.decorationIds.length > 0) {
			return model.getDecorationRange(this.decorationIds[1]);
		}
		return null;
	}

	private getVisualDecorationOptions():EditorCommon.IModelDecorationOptions {
		if (this._isCollapsed) {
			return {
				stickiness: EditorCommon.TrackedRangeStickiness.GrowsOnlyWhenTypingBefore,
				inlineClassName: 'inline-folded',
				linesDecorationsClassName: 'folding collapsed'
			};
		} else {
			return {
				stickiness: EditorCommon.TrackedRangeStickiness.GrowsOnlyWhenTypingBefore,
				linesDecorationsClassName: 'folding'
			};
		}
	}

	private getRangeDecorationOptions():EditorCommon.IModelDecorationOptions {
		return {
			stickiness: EditorCommon.TrackedRangeStickiness.GrowsOnlyWhenTypingBefore
		}
	}

	public update(newRange:IFoldingRange, model:EditorCommon.IModel, changeAccessor:EditorCommon.IModelDecorationsChangeAccessor): void {
		this._lastRange = newRange;

		let newDecorations : EditorCommon.IModelDeltaDecoration[] = [];

		var maxColumn = model.getLineMaxColumn(newRange.startLineNumber);
		var visualRng = {
			startLineNumber: newRange.startLineNumber,
			startColumn: maxColumn - 1,
			endLineNumber: newRange.startLineNumber,
			endColumn: maxColumn
		};
		newDecorations.push({ range: visualRng, options: this.getVisualDecorationOptions() });

		var colRng = {
			startLineNumber: newRange.startLineNumber,
			startColumn: 1,
			endLineNumber: newRange.endLineNumber,
			endColumn: model.getLineMaxColumn(newRange.endLineNumber)
		};
		newDecorations.push({ range: colRng, options: this.getRangeDecorationOptions() });

		this.decorationIds = changeAccessor.deltaDecorations(this.decorationIds, newDecorations);
	}


	public dispose(changeAccessor:EditorCommon.IModelDecorationsChangeAccessor): void {
		this._lastRange = null;
		this.decorationIds = changeAccessor.deltaDecorations(this.decorationIds, []);
	}
}

export class Folding implements EditorCommon.IEditorContribution {

	static ID = 'editor.contrib.folding';

	private editor:ICodeEditor;
	private globalToDispose:IDisposable[];

	private computeToken:number;
	private updateScheduler:RunOnceScheduler;
	private localToDispose:IDisposable[];

	private decorations:CollapsableRegion[];

	constructor(editor:ICodeEditor, @INullService nullService) {
		this.editor = editor;

		this.globalToDispose = [];
		this.localToDispose = [];
		this.decorations = [];
		this.computeToken = 0;

		this.globalToDispose.push(this.editor.addListener2(EditorCommon.EventType.ModelChanged, () => this.onModelChanged()));
		this.globalToDispose.push(this.editor.addListener2(EditorCommon.EventType.ModelModeChanged, () => this.onModelChanged()));

		this.onModelChanged();
	}

	public getId(): string {
		return Folding.ID;
	}

	public dispose(): void {
		this.cleanState();
		this.globalToDispose = disposeAll(this.globalToDispose);
	}

	private cleanState(): void {
		this.localToDispose = disposeAll(this.localToDispose);
	}

	private onModelChanged(): void {
		this.cleanState();

		var model = this.editor.getModel();
		if (!model) {
			return;
		}

		this.updateScheduler = new RunOnceScheduler(() => {
			var myToken = (++this.computeToken);

			this.computeCollapsableRegions().then(regions => {
				if (myToken !== this.computeToken) {
					// A new request was made in the meantime or the model was changed
					return;
				}
				regions = regions.sort((r1, r2) => r1.startLineNumber - r2.startLineNumber);
				log('compute ranges ' + regions.map(rangeToString).join(', '));

				this.editor.changeDecorations(changeAccessor => {

					let newDecorations : CollapsableRegion[] = [];

					let k = 0, i = 0;
					while (i < this.decorations.length && k < regions.length) {
						let dec = this.decorations[i];
						var decRange = dec.getDecorationRange(model);
						if (!decRange) {
							log('range no longer valid, was ' + rangeToString(dec.lastRange));
							dec.dispose(changeAccessor);
							i++;
						} else {
							while (k < regions.length && decRange.startLineNumber > regions[k].startLineNumber) {
								log('new range ' + rangeToString(regions[k]));
								newDecorations.push(new CollapsableRegion(regions[k], model, changeAccessor, false));
								k++;
							}
							if (k < regions.length) {
								let currRange = regions[k];
								if (decRange.startLineNumber < currRange.startLineNumber) {
									log('range no longer valid, was ' + rangeToString(dec.lastRange));
									dec.dispose(changeAccessor);
									i++;
								} else if (decRange.startLineNumber === currRange.startLineNumber) {
									dec.update(currRange, model, changeAccessor);
									newDecorations.push(dec);
									i++;
									k++;
								}
							}
						}
					}
					while (i < this.decorations.length) {
						log('range no longer valid, was ' + rangeToString(this.decorations[i].lastRange));
						this.decorations[i].dispose(changeAccessor);
						i++;
					}
					while (k < regions.length) {
						log('new range ' + rangeToString(regions[k]));
						newDecorations.push(new CollapsableRegion(regions[k], model, changeAccessor, false));
						k++;
					}
					this.decorations = newDecorations;
				});

				this.updateHiddenAreas();
			});
		}, 200);

		this.localToDispose.push(this.updateScheduler);
		this.localToDispose.push(this.editor.addListener2('change', () => this.updateScheduler.schedule()));
		this.localToDispose.push({ dispose: () => {
			++this.computeToken;
			this.editor.changeDecorations((changeAccessor:EditorCommon.IModelDecorationsChangeAccessor) => {
				this.decorations.forEach((dec) => dec.dispose(changeAccessor));
			});
		}});
		this.localToDispose.push(this.editor.addListener2(EditorCommon.EventType.MouseDown, (e) => this._onEditorMouseDown(e)));

		this.updateScheduler.schedule();
	}

	private computeCollapsableRegions() : TPromise<IFoldingRange[]> {
		let tabSize = this.editor.getIndentationOptions().tabSize;
		var model = this.editor.getModel();
		if (!model) {
			return TPromise.as([]);
		}


		let ranges = foldStrategy.computeRanges(model, tabSize);
		return TPromise.as(ranges);
	}

	private _onEditorMouseDown(e:IMouseEvent): void {
		if (e.target.type !== EditorCommon.MouseTargetType.GUTTER_LINE_DECORATIONS) {
			return;
		}
		if (this.decorations.length === 0) {
			return;
		}
		var position = e.target.position;
		if (!position) {
			return;
		}

		var model = this.editor.getModel();

		var hasChanges = false;

		this.editor.changeDecorations(changeAccessor => {
			for (var i = 0; i < this.decorations.length; i++) {
				var dec = this.decorations[i];
				var decRange = dec.getDecorationRange(model);
				if (decRange.startLineNumber === position.lineNumber) {
					dec.setCollapsed(!dec.isCollapsed, changeAccessor);
					hasChanges = true;
					break;
				}
			}
		});

		if (hasChanges) {
			this.updateHiddenAreas();
		}

	}

	private updateHiddenAreas(): void {
		var model = this.editor.getModel();
		var hiddenAreas:EditorCommon.IRange[] = [];
		this.decorations.filter(dec => dec.isCollapsed).forEach(dec => {
			var decRange = dec.getDecorationRange(model);
			hiddenAreas.push({
				startLineNumber: decRange.startLineNumber + 1,
				startColumn: 1,
				endLineNumber: decRange.endLineNumber,
				endColumn: 1
			});
		});
		this.editor.setHiddenAreas(hiddenAreas);
	}
}

EditorBrowserRegistry.registerEditorContribution(Folding);