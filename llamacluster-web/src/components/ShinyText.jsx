import React from 'react';
// React Bits "Shiny Text" pattern; pass `on` to animate (e.g. while the model is thinking).
export default function ShinyText({children,on=true,className=''}){return <span className={'shiny '+(on?'on ':'')+className}>{children}</span>}
