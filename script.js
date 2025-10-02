document.addEventListener('DOMContentLoaded', function() {
    console.log('Welcome to Unfancy!');

    // Create a container for JS demos
    const demoContainer = document.createElement('div');
    demoContainer.style.marginTop = '30px';

    // // --- Demo 1: Button Click with Time ---
    // const btn = document.createElement('button');
    // btn.textContent = 'Show Current Time';
    // btn.style.marginRight = '10px';

    // const output = document.createElement('p');
    // output.id = 'js-demo-output';

    // btn.addEventListener('click', function() {
    //     const now = new Date();
    //     output.textContent = `Current time: ${now.toLocaleTimeString()}`;
    // });

    // demoContainer.appendChild(btn);
    // demoContainer.appendChild(output);

    // // --- Demo 2: Live Counter ---
    // const counterLabel = document.createElement('span');
    // counterLabel.textContent = 'Counter: ';
    // counterLabel.style.marginLeft = '30px';

    // const counterValue = document.createElement('span');
    // counterValue.textContent = '0';
    // counterValue.style.fontWeight = 'bold';

    // let count = 0;
    // setInterval(() => {
    //     count++;
    //     counterValue.textContent = count;
    // }, 1000);

    // demoContainer.appendChild(counterLabel);
    // counterLabel.appendChild(counterValue);

    // // --- Demo 3: Change Background Color ---
    // const colorBtn = document.createElement('button');
    // colorBtn.textContent = 'Random Background';
    // colorBtn.style.marginLeft = '30px';

    // colorBtn.addEventListener('click', function() {
    //     const randomColor = '#' + Math.floor(Math.random()*16777215).toString(16).padStart(6, '0');
    //     document.body.style.backgroundColor = randomColor;
    // });

    // demoContainer.appendChild(colorBtn);

    // Add the demo container to the page
    document.body.appendChild(demoContainer);
});