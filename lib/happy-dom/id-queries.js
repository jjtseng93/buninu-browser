import ParentNodeUtility from '../../vendor/happy-dom/packages/happy-dom/src/nodes/parent-node/ParentNodeUtility.ts';
import {encodingString} from '../renderer/encoding-string.js';
import {elementById} from './node-queries.js';

// Native consumers such as fragment navigation must select the same first
// matching element as page-facing Document/DocumentFragment queries.
ParentNodeUtility.getElementById = function(parent, id) {
  return elementById(parent, encodingString(id, (_name, message) => new TypeError(message)));
};
