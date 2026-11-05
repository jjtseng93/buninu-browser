import {encodingString} from './encoding-string.js';

// Web IDL ByteString: conversion (including author callbacks) happens before
// XHR's state/HTTP checks, and uses the operation's defining realm for errors.
export function xhrByteString(value, error) {
  const text = encodingString(value, (_name, message) => error(message));
  if (/[^\x00-\xff]/.test(text)) throw error('Value is not a ByteString');
  return text;
}
export const xhrUSVString = (value, error) => encodingString(value, (_name, message) => error(message)).toWellFormed();
