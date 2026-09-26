const mk = (kind) => (arg) => { const n = { kind, ...arg, to(x){return n;}, onTrue(){return n;}, onFalse(){return n;}, onError(){return n;} }; return n; };
export const node = mk('node'), trigger = mk('trigger'), ifElse = mk('if');
export const sticky = () => ({}), placeholder = (h) => ({ placeholder: h }), newCredential = (n) => ({ cred: n }), expr = (e) => ({ expr: e });
export const workflow = () => { const w = { add(){return w;}, to(){return w;} }; return w; };
