/*jslint node: true */
const conf = require('byteballcore/conf.js')
const device = require('byteballcore/device.js')
const walletDefinedByKeys = require('byteballcore/wallet_defined_by_keys.js')
const crypto = require('crypto')
const fs = require('fs')
const db = require('byteballcore/db.js')
const eventBus = require('byteballcore/event_bus.js')
const desktopApp = require('byteballcore/desktop_app.js')
require('byteballcore/wallet.js') // we don't need any of its functions but it listens for hub/* messages

const appDataDir = desktopApp.getAppDataDir()
const KEYS_FILENAME = `${appDataDir}/${conf.KEYS_FILENAME}`

let wallet

const arrToppings = {
	hawaiian: {name: 'Hawaiian'},
	pepperoni: {name: 'Pepperoni'},
	mexican: {name: 'Mexican'}
}

const arrYesNoAnswers = {
	yes: 'Yes',
	no: 'No'
}

function getToppingsList() {
	const arrItems = []
	for (const code in arrToppings)
		arrItems.push(`[${arrToppings[code].name}](command:${code})`);
	return arrItems.join("\t")
}

function getYesNoList() {
	const arrItems = []
	for (const code in arrYesNoAnswers)
		arrItems.push(`[${arrYesNoAnswers[code]}](command:${code})`);
	return arrItems.join("\t")
}

function replaceConsoleLog() {
	const clog = console.log
	console.log = function (...args) {
		Array.prototype.unshift.call(args, `${Date().toString()}:`)
		clog(...args)
	}
}

function readKeys(onDone) {
	fs.readFile(KEYS_FILENAME, 'utf8', (err, data) => {
		if (err) {
			console.log('failed to read keys, will gen')
			const devicePrivKey = crypto.randomBytes(32)
			const deviceTempPrivKey = crypto.randomBytes(32)
			const devicePrevTempPrivKey = crypto.randomBytes(32)
			writeKeys(devicePrivKey, deviceTempPrivKey, devicePrevTempPrivKey, () => {
				onDone(devicePrivKey, deviceTempPrivKey, devicePrevTempPrivKey)
			})
			return
		}
		const keys = JSON.parse(data)
		onDone(Buffer(keys.permanent_priv_key, 'base64'), Buffer(keys.temp_priv_key, 'base64'),
			Buffer(keys.prev_temp_priv_key, 'base64'))
	})
}

function writeKeys(devicePrivKey, deviceTempPrivKey, devicePrevTempPrivKey, onDone) {
	const keys = {
		permanent_priv_key: devicePrivKey.toString('base64'),
		temp_priv_key: deviceTempPrivKey.toString('base64'),
		prev_temp_priv_key: devicePrevTempPrivKey.toString('base64')
	}
	fs.writeFile(KEYS_FILENAME, JSON.stringify(keys), 'utf8', err => {
		if (err)
			throw Error("failed to write keys file",err)
		if (onDone)
			onDone()
	})
}

function readCurrentState(device_address, handleState) {
	db.query("SELECT state_id, `order`, step FROM states WHERE device_address=? ORDER BY state_id DESC LIMIT 1", [device_address], rows => {
		if (rows.length === 0)
			throw Error('no current state')
		const state = rows[0]
		state.order = JSON.parse(state.order)
		handleState(state)
	})
}

function createNewSession(device_address, onDone) {
	const step = 'waiting_for_choice_of_pizza'
	db.query("INSERT INTO states (device_address, step, `order`) VALUES (?,?,'{}')", [device_address, step], () => {
		if (onDone)
			onDone()
	})
}

function updateState(state, onDone) {
	db.query(
		"UPDATE states SET step=?, `order`=?, amount=?, address=? WHERE state_id=?",
		[state.step, JSON.stringify(state.order), state.amount, state.address, state.state_id],
		() => {
			if (onDone)
				onDone()
		}
	)
}

function cancelState({state_id}) {
	db.query(`UPDATE states SET cancel_date=${db.getNow()} WHERE state_id=?`, [state_id])
}

function createWallet(onDone) {
	walletDefinedByKeys.createSinglesigWalletWithExternalPrivateKey(conf.xPubKey, conf.account, conf.homeDeviceAddress, _wallet => {
		wallet = _wallet
		onDone()
	})
}

function handleNoWallet(from_address) {
	if (from_address === conf.homeDeviceAddress && wallet === null)
		createWallet(() => {
			device.sendMessageToDevice(from_address, 'text', "Wallet created, all new addresses will be synced to your device")
		})
	else
		device.sendMessageToDevice(from_address, 'text', "The shop is not set up yet, try again later")
}


replaceConsoleLog()

if (!conf.permanent_pairing_secret)
	throw Error('no conf.permanent_pairing_secret')
db.query(
	`INSERT ${db.getIgnore()} INTO pairing_secrets (pairing_secret, expiry_date, is_permanent) VALUES(?, '2035-01-01', 1)`,
	[conf.permanent_pairing_secret]
)

db.query("SELECT wallet FROM wallets", rows => {
	if (rows.length > 1)
		throw Error('more than 1 wallet')
	if (rows.length === 1)
		wallet = rows[0].wallet
	else
		wallet = null // different from undefined
})


readKeys((devicePrivKey, deviceTempPrivKey, devicePrevTempPrivKey) => {
	const saveTempKeys = (new_temp_key, new_prev_temp_key, onDone) => {
		writeKeys(devicePrivKey, new_temp_key, new_prev_temp_key, onDone)
	}
	device.setDevicePrivateKey(devicePrivKey)
	device.setTempKeys(deviceTempPrivKey, devicePrevTempPrivKey, saveTempKeys)
	device.setDeviceName(conf.deviceName)
	device.setDeviceHub(conf.hub)
	const my_device_pubkey = device.getMyDevicePubKey()
	console.log(`my device pubkey: ${my_device_pubkey}`)
	console.log(`my pairing code: ${my_device_pubkey}@${conf.hub}#${conf.permanent_pairing_secret}`)
})


eventBus.on('paired', from_address => {
	if (!wallet)
		return handleNoWallet(from_address)
	createNewSession(from_address, () => {
		device.sendMessageToDevice(from_address, 'text', `Hi! Choose your pizza:\n${getToppingsList()}\nAll pizzas are at 10,000 bytes.`)
	})
})

eventBus.on('text', (from_address, text) => {
	if (!wallet)
		return handleNoWallet(from_address)
	text = text.trim().toLowerCase()
	readCurrentState(from_address, state => {
		switch (state.step) {
			case 'waiting_for_choice_of_pizza':
				if (!arrToppings[text])
					return device.sendMessageToDevice(from_address, 'text', `Please choose one of the toppings available:\n${getToppingsList()}`)
				state.order.pizza = text
				state.step = 'waiting_for_choice_of_cola'
				updateState(state)
				device.sendMessageToDevice(from_address, 'text', `${arrToppings[text].name} at 10,000 bytes.  Add a cola (1,000 bytes)?\n${getYesNoList()}`)
				break

			case 'waiting_for_choice_of_cola':
				if (!arrYesNoAnswers[text])
					return device.sendMessageToDevice(from_address, 'text', "Add a cola (1,000 bytes)?  Please click Yes or No above.")
				walletDefinedByKeys.issueNextAddress(wallet, 0, ({address}) => {
					state.address = address
					state.order.cola = text
					state.step = 'waiting_for_payment'
					state.amount = 10000
					let response = `Your order: ${arrToppings[state.order.pizza].name}`
					if (state.order.cola === 'yes') {
						state.amount += 1000
						response += ' and Cola'
					}
					response += `.\nOrder total is ${state.amount} bytes.  Please pay.\n[${state.amount} bytes](byteball:${state.address}?amount=${state.amount})`
					updateState(state)
					device.sendMessageToDevice(from_address, 'text', response)
				})
				break

			case 'waiting_for_payment':
				if (text !== 'cancel')
					return device.sendMessageToDevice(from_address, 'text', "Waiting for your payment.  If you want to cancel the order and start over, click [Cancel](command:cancel).")
				cancelState(state)
				createNewSession(from_address, () => {
					device.sendMessageToDevice(from_address, 'text', `Order canceled.\nChoose your pizza:\n${getToppingsList()}\nAll pizzas are at 10,000 bytes.`)
				})
				break

			case 'unconfirmed_payment':
				device.sendMessageToDevice(from_address, 'text', "We are waiting for confirmation of your payment.  Be patient.")
				break

			case 'done':
			case 'doublespend':
				createNewSession(from_address, () => {
					let response = (state.step === 'done')
						? "The order was paid and your pizza sent to you.\nIf you want to order another pizza,"
						: "Your payment appeared to be double-spend and was rejected.\nIf you want to make a new order,"
					response += ` choose the topping:\n${getToppingsList()}\nAll pizzas are at 10,000 bytes.`
					device.sendMessageToDevice(from_address, 'text', response)
				})
				break

			default:
				throw Error(`unknown state: ${state}`)
		}
	})
})


eventBus.on('new_my_transactions', arrUnits => {
	db.query(
		"SELECT state_id, outputs.unit, device_address, states.amount AS expected_amount, outputs.amount AS paid_amount \n\
		FROM outputs JOIN states USING(address) WHERE outputs.unit IN(?) AND outputs.asset IS NULL AND pay_date IS NULL",
		[arrUnits],
		rows => {
			rows.forEach(row => {
				if (row.expected_amount !== row.paid_amount)
					return device.sendMessageToDevice(row.device_address, 'text', `Received incorect amount from you: expected ${row.expected_amount} bytes, received ${row.paid_amount} bytes.  The payment is ignored.`)
				db.query(`UPDATE states SET pay_date=${db.getNow()}, unit=?, step='unconfirmed_payment' WHERE state_id=?`, [row.unit, row.state_id])
				device.sendMessageToDevice(row.device_address, 'text', "Received your payment, please wait a few minutes while it is still unconfirmed.")
			})
		}
	)
})

eventBus.on('my_transactions_became_stable', arrUnits => {
	db.query(
		"SELECT state_id, device_address, sequence \n\
		FROM states JOIN units USING(unit) WHERE unit IN(?) AND confirmation_date IS NULL",
		[arrUnits],
		rows => {
			rows.forEach(({sequence, state_id, device_address}) => {
				const step = (sequence === 'good') ? 'done' : 'doublespend'
				db.query(`UPDATE states SET confirmation_date=${db.getNow()}, step=? WHERE state_id=?`, [step, state_id])
				device.sendMessageToDevice(
					device_address, 'text',
					(step === 'done')
						? "Payment confirmed.  Your order is on its way to you!"
						: "Your payment appeared to be double-spend.  The order will not be fulfilled"
				)
				// todo: actually deliver the pizza
			})
		}
	)
})


