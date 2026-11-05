// Array mutations must pass the same checks as assignment and invalidate styles.
// Keep the actual backing array private, including against inherited setters.
export function observableSheets(validate, changed) {
  const values=[];
  const index=key=>typeof key==='string'&&/^(0|[1-9]\d*)$/.test(key)&&Number(key)<4294967295;
  const put=(key,value)=>{
    if(key==='length'){
      const length=Number(value),integer=length>>>0;
      if(length!==integer)throw new RangeError('Invalid array length');
      if(integer>values.length)return false;
      values.length=integer;changed(values);return true;
    }
    if(index(key)){
      if(Number(key)>values.length)return false;
      validate(value);
      Object.defineProperty(values,key,{value,writable:true,enumerable:true,configurable:true});
      changed(values);return true;
    }
    return Reflect.set(values,key,value,view);
  };
  const view=new Proxy(values,{
    preventExtensions(){return false;},
    set(_target,key,value){return put(key,value);},
    defineProperty(_target,key,descriptor){
      if(key==='length'||index(key)){
        if('get' in descriptor||'set' in descriptor||descriptor.configurable===false||descriptor.enumerable===false||descriptor.writable===false)return false;
        if(!('value' in descriptor))return false;
        return put(key,descriptor.value);
      }
      return Reflect.defineProperty(values,key,descriptor);
    },
    deleteProperty(_target,key){
      if(index(key)){
        if(Number(key)!==values.length-1)return false;
        values.length--;changed(values);return true;
      }
      return Reflect.deleteProperty(values,key);
    },
  });
  return {view,replace(iterable){
    const next=Array.from(iterable);for(const value of next)validate(value);
    values.length=0;
    for(let i=0;i<next.length;i++)Object.defineProperty(values,i,{value:next[i],writable:true,enumerable:true,configurable:true});
    changed(values);
  }};
}
