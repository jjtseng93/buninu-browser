import HTMLInputElement from '../../vendor/happy-dom/packages/happy-dom/src/nodes/html-input-element/HTMLInputElement.ts';
import HTMLTextAreaElement from '../../vendor/happy-dom/packages/happy-dom/src/nodes/html-text-area-element/HTMLTextAreaElement.ts';

// HTML reflected long, limited to non-negative numbers. Attribute parsing
// accepts a decimal prefix; IDL assignment first performs WebIDL long conversion.
// https://html.spec.whatwg.org/multipage/common-dom-interfaces.html#reflect
for(const prototype of [HTMLInputElement.prototype,HTMLTextAreaElement.prototype]) {
  for(const name of ['minLength','maxLength']) {
    const attribute=name.toLowerCase();
    Object.defineProperty(prototype,name,{
      ...Object.getOwnPropertyDescriptor(prototype,name),
      get() {
        const source=this.getAttributeNS(null,attribute);
        const digits=source===null?null:/^[\t\n\f\r ]*([+-]?\d+)/.exec(source);
        const value=digits?Number(digits[1]):-1;
        return value>=0&&value<=2147483647?value===0?0:value:-1;
      },
      set(value) {
        value=+value|0;
        if(value<0)throw new DOMException(`${name} must not be negative`,'IndexSizeError');
        this.setAttributeNS(null,attribute,String(value));
      },
    });
  }
}
