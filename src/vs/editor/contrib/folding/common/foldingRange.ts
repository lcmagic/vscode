/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

'use strict';

export interface IFoldingRange {
	startLineNumber:number;
	endLineNumber:number;
}

export function toString(range: IFoldingRange) {
	return range ? range.startLineNumber + '/' + range.endLineNumber : 'null';
}