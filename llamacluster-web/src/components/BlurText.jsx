import React from 'react';
// React Bits "Blur Text": words (or letters) resolve out of a blur, one after another. Plays when it mounts;
// give it a `key` that changes with the text to play it again. The full text stays available to screen readers.
export default function BlurText({text='',by='word',delay=70,className='',as:Tag='span'}){
  const parts=by==='letter'?[...text]:text.split(' ');
  return <Tag className={'blurtext '+className} aria-label={text}>{parts.map((p,i)=><React.Fragment key={i}>{by==='word'&&i>0?' ':''}
    <span className="bt" aria-hidden="true" style={{'--i':Math.min(i,28),'--d':delay+'ms'}}>{p}</span></React.Fragment>)}</Tag>;
}
